import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { MessageStreamAccumulator, type StreamOutput } from "./anthropicStream";

type Event = Anthropic.Messages.RawMessageStreamEvent;

/** The SDK types demand fields irrelevant to these tests; cast once here. */
function ev(event: object): Event {
  return event as Event;
}

function messageStart(
  usage: Record<string, number | null> = {},
  model = "claude-sonnet-4-5",
): Event {
  return ev({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, ...usage },
    },
  });
}

function textStart(index: number, text = ""): Event {
  return ev({
    type: "content_block_start",
    index,
    content_block: { type: "text", text, citations: null },
  });
}

function toolStart(
  index: number,
  id: string,
  name: string,
  input: unknown = {},
): Event {
  return ev({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input },
  });
}

function textDelta(index: number, text: string): Event {
  return ev({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function jsonDelta(index: number, partial_json: string): Event {
  return ev({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });
}

function blockStop(index: number): Event {
  return ev({ type: "content_block_stop", index });
}

function messageDelta(
  stop_reason: string | null,
  usage: Record<string, number | null> = {},
): Event {
  return ev({
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: {
      output_tokens: 0,
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      ...usage,
    },
  });
}

const messageStop = ev({ type: "message_stop" });

function feed(acc: MessageStreamAccumulator, events: Event[]): StreamOutput[] {
  return events.flatMap((event) => acc.handle(event));
}

describe("MessageStreamAccumulator", () => {
  it("emits text in stream order", () => {
    const acc = new MessageStreamAccumulator();
    expect(acc.outputStarted).toBe(false);
    const out = feed(acc, [
      messageStart(),
      textStart(0, "He"),
      textDelta(0, "llo"),
      textDelta(0, ""),
      textDelta(0, ", world"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    ]);
    expect(out).toEqual([
      { kind: "text", text: "He" },
      { kind: "text", text: "llo" },
      { kind: "text", text: ", world" },
    ]);
    expect(acc.outputStarted).toBe(true);
    expect(acc.finish()).toEqual([]);
  });

  it("does not emit an empty initial text block", () => {
    const acc = new MessageStreamAccumulator();
    expect(acc.handle(textStart(0))).toEqual([]);
    expect(acc.outputStarted).toBe(false);
  });

  it("reassembles a tool call split across input_json_delta fragments", () => {
    const acc = new MessageStreamAccumulator();
    const out = feed(acc, [
      messageStart(),
      toolStart(0, "toolu_1", "read_file"),
      jsonDelta(0, ""),
      jsonDelta(0, '{"pa'),
      jsonDelta(0, 'th": "src/a'),
      jsonDelta(0, '.ts", "lines": [1, 2]}'),
      blockStop(0),
      messageDelta("tool_use"),
    ]);
    expect(out).toEqual([]);
    expect(acc.outputStarted).toBe(true);
    expect(acc.finish()).toEqual([
      {
        id: "toolu_1",
        name: "read_file",
        input: { path: "src/a.ts", lines: [1, 2] },
      },
    ]);
  });

  it("orders parallel tool blocks by index", () => {
    const acc = new MessageStreamAccumulator();
    const out = feed(acc, [
      textStart(0),
      textDelta(0, "Checking both."),
      blockStop(0),
      toolStart(2, "toolu_b", "second"),
      toolStart(1, "toolu_a", "first"),
      jsonDelta(2, '{"n": 2}'),
      jsonDelta(1, '{"n": 1}'),
      blockStop(1),
      blockStop(2),
    ]);
    expect(out).toEqual([{ kind: "text", text: "Checking both." }]);
    expect(acc.finish()).toEqual([
      { id: "toolu_a", name: "first", input: { n: 1 } },
      { id: "toolu_b", name: "second", input: { n: 2 } },
    ]);
  });

  it("reports malformed and non-object input as {} with the raw text", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      toolStart(0, "toolu_1", "broken"),
      jsonDelta(0, '  {"path": '),
      toolStart(1, "toolu_2", "array"),
      jsonDelta(1, "[1, 2]"),
      toolStart(2, "toolu_3", "scalar"),
      jsonDelta(2, "42"),
      toolStart(3, "toolu_4", "null"),
      jsonDelta(3, "null"),
      toolStart(4, "toolu_5", "empty"),
    ]);
    expect(acc.finish()).toEqual([
      {
        id: "toolu_1",
        name: "broken",
        input: {},
        malformedArguments: '{"path":',
      },
      {
        id: "toolu_2",
        name: "array",
        input: {},
        malformedArguments: "[1, 2]",
      },
      {
        id: "toolu_3",
        name: "scalar",
        input: {},
        malformedArguments: "42",
      },
      {
        id: "toolu_4",
        name: "null",
        input: {},
        malformedArguments: "null",
      },
      { id: "toolu_5", name: "empty", input: {} },
    ]);
  });

  it("falls back to the start-block input when nothing is streamed", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      toolStart(0, "toolu_1", "whole", { path: "x" }),
      blockStop(0),
      toolStart(1, "toolu_2", "streamed", { stale: true }),
      jsonDelta(1, '{"fresh": true}'),
      toolStart(2, "toolu_3", "array_start", [1]),
    ]);
    expect(acc.finish()).toEqual([
      { id: "toolu_1", name: "whole", input: { path: "x" } },
      { id: "toolu_2", name: "streamed", input: { fresh: true } },
      { id: "toolu_3", name: "array_start", input: {} },
    ]);
  });

  it("skips tool blocks without a name and stray json deltas", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      toolStart(0, "toolu_1", ""),
      jsonDelta(0, "{}"),
      jsonDelta(5, '{"orphan": true}'),
    ]);
    expect(acc.finish()).toEqual([]);
  });

  it("ignores thinking, redacted and server-tool blocks", () => {
    const acc = new MessageStreamAccumulator();
    const out = feed(acc, [
      messageStart(),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me see" },
      }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      }),
      blockStop(0),
      ev({
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque" },
      }),
      blockStop(1),
      ev({
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: {},
        },
      }),
      jsonDelta(2, '{"query": "x"}'),
      blockStop(2),
      ev({
        type: "content_block_delta",
        index: 3,
        delta: {
          type: "citations_delta",
          citation: { type: "char_location" },
        },
      }),
      ev({ type: "some_future_event" }),
    ]);
    expect(out).toEqual([]);
    expect(acc.outputStarted).toBe(false);
    expect(acc.finish()).toEqual([]);

    expect(feed(acc, [textStart(4), textDelta(4, "Answer")])).toEqual([
      { kind: "text", text: "Answer" },
    ]);
    expect(acc.outputStarted).toBe(true);
  });

  it("combines usage from message_start and message_delta", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      messageStart({
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
        output_tokens: 1,
      }),
      textStart(0, "Hi"),
      messageDelta(null, { output_tokens: 10 }),
      messageDelta("end_turn", { output_tokens: 42 }),
    ]);
    expect(acc.usage()).toEqual({
      inputTokens: 1050,
      cachedInputTokens: 900,
      outputTokens: 42,
      reasoningTokens: 0,
    });
  });

  it("treats null cache counts on message_start as zero", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      messageStart({
        input_tokens: 12,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens: 3,
      }),
    ]);
    expect(acc.usage()).toEqual({
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
    });
  });

  it("takes input counts reported only in message_delta", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      messageStart(),
      messageDelta("end_turn", {
        input_tokens: 200,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 5,
        output_tokens: 7,
      }),
    ]);
    expect(acc.usage()).toEqual({
      inputTokens: 505,
      cachedInputTokens: 300,
      outputTokens: 7,
      reasoningTokens: 0,
    });
  });

  it("keeps message_start input when message_delta reports it as null", () => {
    const acc = new MessageStreamAccumulator();
    feed(acc, [
      messageStart({ input_tokens: 80, cache_read_input_tokens: 20 }),
      messageDelta("end_turn", { output_tokens: 4 }),
    ]);
    expect(acc.usage()).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 0,
    });
  });

  it("reports no usage when none was seen", () => {
    expect(new MessageStreamAccumulator().usage()).toBeUndefined();
    const acc = new MessageStreamAccumulator();
    feed(acc, [textStart(0, "x"), textDelta(0, "y"), messageStop]);
    expect(acc.usage()).toBeUndefined();
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    ["something_new", "something_new"],
  ])("maps stop reason %s to %s", (reason, expected) => {
    const acc = new MessageStreamAccumulator();
    acc.handle(messageDelta(reason));
    expect(acc.stopReason).toBe(reason);
    expect(acc.finishReasonForOpenAI()).toBe(expected);
  });

  it("has no stop reason until message_delta reports one", () => {
    const acc = new MessageStreamAccumulator();
    expect(acc.stopReason).toBeUndefined();
    expect(acc.finishReasonForOpenAI()).toBeUndefined();
    acc.handle(messageDelta(null));
    expect(acc.stopReason).toBeUndefined();
    expect(acc.finishReasonForOpenAI()).toBeUndefined();
  });

  it("records the served model from message_start", () => {
    const acc = new MessageStreamAccumulator();
    expect(acc.servedModel).toBeUndefined();
    acc.handle(messageStart({}, "claude-opus-4-1-20250805"));
    expect(acc.servedModel).toBe("claude-opus-4-1-20250805");
  });
});
