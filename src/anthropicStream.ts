import type Anthropic from "@anthropic-ai/sdk";

import type { RequestUsage } from "./usage";

/**
 * Consumes an Anthropic Messages stream event by event: the passthrough
 * equivalent of the OpenAI path's chunk loop plus ToolCallAccumulator.
 *
 * Only text is surfaced incrementally. Tool calls are held until `finish`,
 * as on the OpenAI path, because `input_json_delta` fragments are not valid
 * JSON until the block is complete.
 *
 * Deliberately free of any `vscode` import so the protocol handling stays
 * trivially testable; the provider maps the outputs onto response parts.
 */

export type StreamOutput = { kind: "text"; text: string };

export type StreamedToolCall = {
  id: string;
  name: string;
  input: object;
  /** Set when the model's input would not parse; the raw text, trimmed. */
  malformedArguments?: string;
};

type ToolBlock = {
  id: string;
  name: string;
  json: string;
  /**
   * Input sent whole on the start block. The API sends `{}` there and
   * streams the real input, but a gateway that does not stream tool input
   * may put it all here instead.
   */
  startInput?: object;
};

/**
 * Token counts as last reported. Each field is tracked separately because the
 * gateway may report input counts on `message_start`, on `message_delta`, or
 * both, and the later cumulative figure is the authoritative one.
 */
type UsageCounts = {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
};

export class MessageStreamAccumulator {
  private readonly tools = new Map<number, ToolBlock>();
  private counts: UsageCounts | undefined;
  private stop: string | undefined;
  private model: string | undefined;
  private started = false;

  handle(event: Anthropic.Messages.RawMessageStreamEvent): StreamOutput[] {
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event);
      case "content_block_start":
        return this.onBlockStart(event);
      case "content_block_delta":
        return this.onBlockDelta(event);
      case "message_delta":
        this.onMessageDelta(event);
        return [];
      default:
        // message_stop and content_block_stop carry nothing to emit;
        // the default also absorbs event types newer than the SDK.
        return [];
    }
  }

  /**
   * True once anything the user would see has arrived. Thinking blocks do
   * not count: a failure after only thinking can still be retried or
   * reported without leaving a half-written answer behind.
   */
  get outputStarted(): boolean {
    return this.started;
  }

  get stopReason(): string | undefined {
    return this.stop;
  }

  /** The model that actually served the request, which routing may change. */
  get servedModel(): string | undefined {
    return this.model;
  }

  /**
   * Maps to the extension's accounting, whose `inputTokens` includes cached
   * input. Anthropic's `input_tokens` excludes cache reads and writes, so
   * all three are summed; otherwise cached turns would look nearly free of
   * input and the cost estimate would be skewed.
   */
  usage(): RequestUsage | undefined {
    if (!this.counts) {
      return undefined;
    }
    const { input, cacheRead, cacheCreation, output } = this.counts;
    return {
      inputTokens: input + cacheRead + cacheCreation,
      cachedInputTokens: cacheRead,
      outputTokens: output,
      // Anthropic folds thinking into output_tokens without a
      // separate count the extension could rely on.
      reasoningTokens: 0,
    };
  }

  finish(): StreamedToolCall[] {
    const calls: StreamedToolCall[] = [];
    for (const [, block] of [...this.tools.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (!block.name) {
        continue;
      }
      const parsed =
        block.json.trim().length === 0 && block.startInput
          ? { input: block.startInput }
          : parseToolInput(block.json);
      calls.push({
        id: block.id,
        name: block.name,
        input: parsed.input,
        ...(parsed.malformed ? { malformedArguments: parsed.malformed } : {}),
      });
    }
    return calls;
  }

  /**
   * The provider's completion handling speaks OpenAI's `finish_reason`
   * vocabulary, so the passthrough translates rather than teaching every
   * consumer a second set. Unknown values pass through unchanged so they
   * still reach the logs.
   */
  finishReasonForOpenAI(): string | undefined {
    switch (this.stop) {
      case undefined:
        return undefined;
      // pause_turn: the server paused a long-running turn; what
      // arrived so far is a complete, if short, answer.
      case "end_turn":
      case "stop_sequence":
      case "pause_turn":
        return "stop";
      case "max_tokens":
      case "model_context_window_exceeded":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "refusal":
        return "content_filter";
      default:
        return this.stop;
    }
  }

  private onMessageStart(
    event: Anthropic.Messages.RawMessageStartEvent,
  ): StreamOutput[] {
    const { message } = event;
    if (message.model) {
      this.model = message.model;
    }
    const usage = message.usage as
      Partial<Anthropic.Messages.Usage> | undefined;
    if (usage) {
      const counts = this.ensureCounts();
      counts.input = usage.input_tokens ?? counts.input;
      counts.cacheRead = usage.cache_read_input_tokens ?? counts.cacheRead;
      counts.cacheCreation =
        usage.cache_creation_input_tokens ?? counts.cacheCreation;
      counts.output = usage.output_tokens ?? counts.output;
    }
    return [];
  }

  private onBlockStart(
    event: Anthropic.Messages.RawContentBlockStartEvent,
  ): StreamOutput[] {
    const block = event.content_block;
    if (block.type === "text") {
      if (block.text) {
        this.started = true;
        return [{ kind: "text", text: block.text }];
      }
      return [];
    }
    if (block.type === "tool_use") {
      this.started = true;
      const input: unknown = block.input;
      const hasInput =
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        Object.keys(input).length > 0;
      this.tools.set(event.index, {
        id: block.id,
        name: block.name,
        json: "",
        ...(hasInput ? { startInput: input } : {}),
      });
    }
    // Thinking, redacted thinking and server-tool blocks are not
    // surfaced; their deltas are ignored below.
    return [];
  }

  private onBlockDelta(
    event: Anthropic.Messages.RawContentBlockDeltaEvent,
  ): StreamOutput[] {
    const { delta } = event;
    if (delta.type === "text_delta") {
      if (!delta.text) {
        return [];
      }
      this.started = true;
      return [{ kind: "text", text: delta.text }];
    }
    if (delta.type === "input_json_delta") {
      // A delta for a block never started (or not a tool block) has no
      // call to belong to; dropping it beats inventing a nameless one.
      const tool = this.tools.get(event.index);
      if (tool) {
        tool.json += delta.partial_json;
      }
    }
    return [];
  }

  private onMessageDelta(event: Anthropic.Messages.RawMessageDeltaEvent): void {
    if (event.delta.stop_reason) {
      this.stop = event.delta.stop_reason;
    }
    const usage = event.usage as
      Partial<Anthropic.Messages.MessageDeltaUsage> | undefined;
    if (!usage) {
      return;
    }
    const counts = this.ensureCounts();
    // Output is cumulative, so the latest figure replaces the earlier one.
    counts.output = usage.output_tokens ?? counts.output;
    counts.input = usage.input_tokens ?? counts.input;
    counts.cacheRead = usage.cache_read_input_tokens ?? counts.cacheRead;
    counts.cacheCreation =
      usage.cache_creation_input_tokens ?? counts.cacheCreation;
  }

  private ensureCounts(): UsageCounts {
    this.counts ??= { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
    return this.counts;
  }
}

type ParsedInput = { input: object; malformed?: string };

/**
 * Same rules as the OpenAI path's parseToolArguments, duplicated because
 * provider.ts imports `vscode`: an unparseable or non-object input becomes
 * `{}` so the tool reports a normal validation failure instead of breaking
 * the turn, and the offending text is kept so the caller can log it.
 */
function parseToolInput(json: string): ParsedInput {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    return { input: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return { input: parsed };
    }
    return { input: {}, malformed: trimmed };
  } catch {
    return { input: {}, malformed: trimmed };
  }
}
