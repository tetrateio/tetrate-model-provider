import OpenAI, { type ClientOptions } from 'openai';
import * as vscode from 'vscode';

import {
    type CatalogModel,
    fetchApiModels,
    type ModelPricing,
    pricingOf,
    RequestTimeoutError,
    selectChatModels,
} from './catalog';
import { loadPublicCatalog, peekPublicCatalog } from './catalogCache';
import {
    getConfig,
    type ModelOverride,
    overridesFor,
    type ProviderConfig,
} from './config';
import { convertMessages, convertToolMode, convertTools } from './messages';
import { getApiKey, promptForApiKey } from './secrets';
import { countTokens } from './tokenCount';
import { formatCost, formatTokens, type RequestUsage, UsageTracker } from './usage';

const USER_AGENT = 'vscode-tetrate-model-provider';

/**
 * Bounds the wait for response headers. The SDK clears its timer as soon as
 * fetch resolves, which is before any body bytes arrive, so this says nothing
 * about the first token; FIRST_OUTPUT_TIMEOUT_MS below covers that. The SDK's
 * own default is ten minutes, which is indistinguishable from a hang.
 */
const RESPONSE_TIMEOUT_MS = 120_000;

/**
 * How long a stream may run before its first content or tool-call delta.
 * Reasoning models over chat completions send nothing while they think, so a
 * high-effort request on a long prompt can legitimately pass the idle limit
 * below before the first token. Reporting that as a stall would fail exactly
 * the answers that take the most compute to produce.
 */
export const FIRST_OUTPUT_TIMEOUT_MS = 180_000;

/**
 * Once output has started, a stream that goes this long between chunks is
 * treated as dead. The SDK's timeout covers the response headers only, so
 * without this a gateway that stops mid-answer leaves the turn hanging until
 * the user cancels.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * How long a model list stays usable. Bounded so a newly added upstream model
 * appears on its own, rather than only after a window reload or a manual
 * refresh, but long enough that normal use costs no extra requests.
 */
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Invalidations arrive in bursts — a settings.json edit fires one per
 * keystroke, and storing the key fires both our own call and the secret-change
 * listener. Coalescing them keeps VS Code from re-querying each time.
 */
const CHANGE_DEBOUNCE_MS = 50;

type CachedModels = {
    key: string;
    models: vscode.LanguageModelChatInformation[];
    at: number;
};

export class TetrateChatModelProvider
    implements vscode.LanguageModelChatProvider, vscode.Disposable
{
    private readonly onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this.onDidChange.event;

    /** Session usage totals; the extension wires this to the status bar. */
    readonly usage = new UsageTracker();

    /** Keyed by base URL and filter so a settings change cannot serve stale models. */
    private cache?: CachedModels;

    /**
     * Catalog prices by lowercased model id, for costing responses. Filled by
     * discovery, and lazily from the stored catalog for a window that answers
     * a request before it ever lists models.
     */
    private pricingById?: Map<string, ModelPricing>;

    /** Collapses overlapping discovery calls onto one pair of requests. */
    private inflight?: {
        key: string;
        promise: Promise<vscode.LanguageModelChatInformation[]>;
    };

    /**
     * Secret storage is an IPC round trip to the main process, paid before
     * every request otherwise. Boxed so an absent key is cached too, and
     * dropped by invalidate(), which the secret-change listener drives.
     */
    private keyCache?: { value: string | undefined };

    private changeTimer?: ReturnType<typeof setTimeout>;

    /** Disambiguates synthesized tool-call ids across turns; see finish(). */
    private turn = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: vscode.LogOutputChannel,
        /** Lets tests substitute a scripted client; production uses the SDK. */
        private readonly createClient: (options: ClientOptions) => OpenAI = (
            options
        ) => new OpenAI(options)
    ) {}

    dispose(): void {
        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
            this.changeTimer = undefined;
        }
        this.onDidChange.dispose();
    }

    /**
     * Discards everything derived from the key or the settings and asks VS Code
     * to re-query. Called after the key or base URL changes, and by the refresh
     * command.
     */
    invalidate(): void {
        this.cache = undefined;
        this.inflight = undefined;
        this.keyCache = undefined;

        if (this.changeTimer) {
            return;
        }
        this.changeTimer = setTimeout(() => {
            this.changeTimer = undefined;
            this.onDidChange.fire();
        }, CHANGE_DEBOUNCE_MS);
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = getConfig();
        const apiKey = await this.resolveApiKey(options.silent, config.baseUrl);
        if (!apiKey) {
            // With no key there is nothing to offer. Staying quiet here is
            // required in silent mode and reasonable otherwise, since the user
            // just dismissed the prompt.
            return [];
        }

        // The API key is deliberately not part of this key: every path that
        // changes it calls invalidate(), and keeping the secret out of a
        // long-lived string avoids it surfacing anywhere unintended.
        const cacheKey = `${config.baseUrl}|${config.modelFilter.join(',')}`;
        const cached = this.cache;
        if (cached?.key === cacheKey && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
            return cached.models;
        }

        // VS Code asks from several places at once on startup. Joining the
        // in-flight call means one pair of requests instead of one per caller.
        // Joiners inherit the initiator's cancellation token: if that caller
        // gives up, everyone gets an empty list and the next call retries.
        if (this.inflight?.key === cacheKey) {
            return this.inflight.promise;
        }

        const promise = this.discover(config, apiKey, cacheKey, options, token);
        this.inflight = { key: cacheKey, promise };
        try {
            return await promise;
        } finally {
            if (this.inflight?.promise === promise) {
                this.inflight = undefined;
            }
        }
    }

    private async discover(
        config: ProviderConfig,
        apiKey: string,
        cacheKey: string,
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        try {
            const [apiModels, catalog] = await Promise.all([
                fetchApiModels(
                    config.baseUrl,
                    apiKey,
                    config.requestHeaders,
                    token
                ),
                loadPublicCatalog(this.context.globalState, token),
            ]);

            const models = selectChatModels(apiModels, catalog, config);
            this.pricingById = indexPricing(catalog.values());
            this.log.info(
                `Discovered ${models.length} chat model(s) at ${config.baseUrl}`
            );
            if (models.length === 0 && apiModels.length > 0) {
                this.log.warn(
                    `${apiModels.length} model(s) returned but none matched the chat filter`
                );
            }

            this.cache = { key: cacheKey, models, at: Date.now() };
            return models;
        } catch (error) {
            if (token.isCancellationRequested) {
                return [];
            }
            this.log.error(`Failed to list models: ${describe(error)}`);
            if (!options.silent) {
                await this.reportListFailure(error);
            }
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = getConfig();
        const apiKey = await this.currentApiKey(config.baseUrl);
        if (!apiKey) {
            throw vscode.LanguageModelError.NoPermissions(
                'No Agent Router API key is configured. Run "Tetrate Agent Router: Set Agent Router API Key".'
            );
        }

        const chatMessages = convertMessages(messages, {
            toolResultImages: model.capabilities?.imageInput === true,
        });
        if (chatMessages.length === 0) {
            this.log.warn(
                `Request to ${model.id} carried no convertible content; nothing was sent.`
            );
            return;
        }

        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() =>
            controller.abort()
        );

        // A stall and a user cancellation both arrive as an abort; this tells
        // them apart. The error is built where the timer fires because only
        // that knows which allowance ran out.
        let stalled: Error | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const armIdleTimer = (phase: 'first' | 'idle') => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            const ms =
                phase === 'first'
                    ? FIRST_OUTPUT_TIMEOUT_MS
                    : STREAM_IDLE_TIMEOUT_MS;
            idleTimer = setTimeout(() => {
                const seconds = Math.round(ms / 1000);
                stalled = new Error(
                    phase === 'first'
                        ? `Agent Router: ${model.id} produced no output for ${seconds}s.`
                        : `Agent Router: the response from ${model.id} stalled for ${seconds}s with no data.`
                );
                controller.abort();
            }, ms);
        };

        try {
            const tools = convertTools(options.tools);
            const stream = await this.client(config, apiKey).chat.completions.create(
                {
                    // Callers may pass provider-specific knobs such as
                    // temperature, max_tokens or reasoning_effort straight
                    // through. Spread first so the fields below cannot be
                    // overridden — clobbering `stream` or `messages` would
                    // break the response handling outright. The per-model
                    // overrides sit in between: they are the user's own
                    // setting, so they outrank a calling extension's defaults.
                    ...(options.modelOptions ?? {}),
                    ...overrideParams(
                        overridesFor(model.id, config.modelOverrides)
                    ),
                    model: model.id,
                    messages: chatMessages,
                    stream: true,
                    // Asks for billed token counts on a final chunk that
                    // carries an empty `choices` array.
                    stream_options: { include_usage: true },
                    ...(tools
                        ? {
                              tools,
                              tool_choice: convertToolMode(options.toolMode),
                          }
                        : {}),
                },
                { signal: controller.signal }
            );

            const toolCalls = new ToolCallAccumulator(`call_${this.turn++}`);
            let finishReason: string | undefined;
            let usage: OpenAI.Completions.CompletionUsage | undefined;
            let reportedText = 0;
            let outputStarted = false;

            // A chunk carrying an `error` field never reaches this loop: the
            // SDK raises it as an APIError before yielding.
            armIdleTimer('first');
            for await (const chunk of stream) {
                if (chunk.usage) {
                    usage = chunk.usage;
                }
                const choice = chunk.choices[0];
                if (choice?.finish_reason) {
                    finishReason = choice.finish_reason;
                }

                const delta = choice?.delta;
                if (delta?.content) {
                    reportedText += delta.content.length;
                    progress.report(
                        new vscode.LanguageModelTextPart(delta.content)
                    );
                    outputStarted = true;
                }
                if (delta?.tool_calls?.length) {
                    toolCalls.add(delta.tool_calls);
                    outputStarted = true;
                }

                // Armed after the chunk is handled so the allowance measures
                // the gap to the next one. Role-only and reasoning chunks keep
                // the longer allowance: the model has not started answering.
                armIdleTimer(outputStarted ? 'idle' : 'first');
            }

            // The SDK's iterator returns quietly on the abort it sees
            // mid-stream, so a stall or a cancellation ends the loop as though
            // the answer were complete.
            if (stalled) {
                throw stalled;
            }
            if (token.isCancellationRequested) {
                return;
            }

            // Arguments arrive as string fragments, so a call is only reportable
            // once the stream has finished delivering it.
            const calls = toolCalls.finish();
            for (const call of calls) {
                if (call.malformedArguments) {
                    this.log.warn(
                        `${model.id} sent unparseable arguments for tool "${call.name}"; passing an empty object: ${call.malformedArguments.slice(0, 200)}`
                    );
                }
                progress.report(
                    new vscode.LanguageModelToolCallPart(
                        call.id,
                        call.name,
                        call.input
                    )
                );
            }

            this.reportFinishReason(
                model,
                finishReason,
                reportedText,
                calls.length,
                progress
            );
            this.recordUsage(model.id, usage);
        } catch (error) {
            if (stalled) {
                this.log.error(stalled.message);
                throw stalled;
            }
            if (isAbort(error) || token.isCancellationRequested) {
                return;
            }
            this.log.error(
                `Request to ${model.id} failed: ${describe(error)}`
            );
            throw toLanguageModelError(error);
        } finally {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            cancellation.dispose();
        }
    }

    /**
     * A truncated or filtered answer is otherwise indistinguishable from a
     * complete one, which turns a one-setting fix into a debugging session.
     */
    private reportFinishReason(
        model: vscode.LanguageModelChatInformation,
        finishReason: string | undefined,
        reportedText: number,
        toolCallCount: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        const produced = reportedText > 0 || toolCallCount > 0;

        if (finishReason === 'length') {
            this.log.warn(
                `${model.id} hit its output limit (${model.maxOutputTokens} tokens); the answer is truncated.`
            );
            progress.report(
                new vscode.LanguageModelTextPart(
                    '\n\n_[Truncated: the model reached its output token limit.]_'
                )
            );
            return;
        }

        if (finishReason === 'content_filter') {
            this.log.warn(`${model.id} stopped on a content filter.`);
            if (!produced) {
                throw vscode.LanguageModelError.Blocked(
                    `Agent Router: ${model.id} blocked this request with a content filter.`
                );
            }
            progress.report(
                new vscode.LanguageModelTextPart(
                    '\n\n_[Stopped early: a content filter interrupted the response.]_'
                )
            );
            return;
        }

        if (!produced) {
            this.log.warn(
                `${model.id} returned an empty response (finish_reason=${finishReason ?? 'none'}).`
            );
        }
    }

    /**
     * Books the billed counts from the stream's usage block. A gateway that
     * ignores `stream_options` sends none, which is booked as nothing rather
     * than as a zero-token request.
     */
    private recordUsage(
        modelId: string,
        usage: OpenAI.Completions.CompletionUsage | undefined
    ): void {
        if (!usage) {
            return;
        }
        const request: RequestUsage = {
            inputTokens: usage.prompt_tokens ?? 0,
            cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            reasoningTokens:
                usage.completion_tokens_details?.reasoning_tokens ?? 0,
        };
        const cost = this.usage.record(
            modelId,
            request,
            this.pricingFor(modelId)
        );

        const cached =
            request.cachedInputTokens > 0
                ? ` (${formatTokens(request.cachedInputTokens)} cached)`
                : '';
        const reasoning =
            request.reasoningTokens > 0
                ? ` incl. ${formatTokens(request.reasoningTokens)} reasoning`
                : '';
        this.log.info(
            `${modelId}: ${formatTokens(request.inputTokens)} in${cached} + ${formatTokens(request.outputTokens)} out${reasoning}${
                cost !== undefined ? ` ≈ ${formatCost(cost)}` : ''
            }`
        );
    }

    private pricingFor(modelId: string): ModelPricing | undefined {
        if (!this.pricingById) {
            // No discovery has run in this window yet; the stored catalog is
            // still likely to know the model, and reading it is synchronous.
            this.pricingById = indexPricing(
                peekPublicCatalog(this.context.globalState)?.models ?? []
            );
        }
        return this.pricingById.get(modelId.toLowerCase());
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        return countTokens(text);
    }

    /**
     * Reads the key stored for this endpoint, going to secret storage at most
     * once per invalidation. A base URL change invalidates through the
     * configuration listener, so the cache never crosses hosts.
     */
    private async currentApiKey(baseUrl: string): Promise<string | undefined> {
        if (!this.keyCache) {
            this.keyCache = { value: await getApiKey(this.context, baseUrl) };
        }
        return this.keyCache.value;
    }

    /**
     * Returns a usable key, prompting only when allowed to. `silent` mirrors
     * {@link vscode.PrepareLanguageModelChatModelOptions.silent}: VS Code
     * resolves models in the background at startup and must not raise a dialog
     * then.
     */
    private async resolveApiKey(
        silent: boolean,
        baseUrl: string
    ): Promise<string | undefined> {
        const existing = await this.currentApiKey(baseUrl);
        if (existing || silent) {
            return existing;
        }
        const prompted = await promptForApiKey(this.context, baseUrl);
        if (prompted) {
            this.keyCache = { value: prompted };
        }
        return prompted;
    }

    private client(config: ProviderConfig, apiKey: string): OpenAI {
        // Cheap to construct, and the base URL or key may have changed since the
        // last request, so this is not cached.
        return this.createClient({
            apiKey,
            baseURL: config.baseUrl,
            timeout: RESPONSE_TIMEOUT_MS,
            // Connection failures and 429/5xx before the stream opens are worth
            // retrying; the SDK stops once bytes are flowing, so a partially
            // delivered answer is never re-requested.
            maxRetries: 2,
            defaultHeaders: {
                'User-Agent': USER_AGENT,
                ...config.requestHeaders,
            },
        });
    }

    private async reportListFailure(error: unknown): Promise<void> {
        const setKey = 'Set API Key';
        const setUrl = 'Set Base URL';
        const action = await vscode.window.showErrorMessage(
            `Tetrate Agent Router: could not list models. ${describe(error)}`,
            setKey,
            setUrl
        );
        if (action === setKey) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setApiKey'
            );
        } else if (action === setUrl) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setBaseUrl'
            );
        }
    }
}

function indexPricing(
    models: Iterable<CatalogModel>
): Map<string, ModelPricing> {
    const byId = new Map<string, ModelPricing>();
    for (const model of models) {
        const pricing = pricingOf(model);
        if (pricing) {
            byId.set(model.model.toLowerCase(), pricing);
        }
    }
    return byId;
}

/** The request-shaped half of a per-model override. */
function overrideParams(
    override: ModelOverride
): Partial<OpenAI.Chat.Completions.ChatCompletionCreateParams> {
    return {
        ...(override.temperature !== undefined
            ? { temperature: override.temperature }
            : {}),
        ...(override.reasoningEffort !== undefined
            ? { reasoning_effort: override.reasoningEffort }
            : {}),
    };
}

type StreamedToolCall = {
    id: string;
    name: string;
    input: object;
    /** Set when the model's arguments would not parse; see {@link parseArguments}. */
    malformedArguments?: string;
};

/**
 * Reassembles tool calls from streaming deltas. The protocol identifies a call
 * by its position in the array; `arguments` arrives as fragments to be joined,
 * while `id` and `name` are sent whole.
 */
export class ToolCallAccumulator {
    private readonly byIndex = new Map<
        number,
        { id: string; name: string; args: string }
    >();

    /**
     * @param idPrefix Distinguishes ids synthesized for a gateway that omits
     * them. Index alone is unique only within one response, so replaying a
     * history of such turns would otherwise repeat `call_0`.
     */
    constructor(private readonly idPrefix = 'call') {}

    add(
        deltas:
            | readonly OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
            | undefined
    ): void {
        for (const delta of deltas ?? []) {
            const entry = this.byIndex.get(delta.index) ?? {
                id: '',
                name: '',
                args: '',
            };
            if (delta.id) {
                entry.id = delta.id;
            }
            if (delta.function?.name) {
                // OpenAI sends the name whole in the first delta, and the
                // SDK's own accumulator assigns it rather than appending. Some
                // compatible gateways repeat the full name on every chunk,
                // which appending would turn into `read_fileread_file`.
                entry.name = delta.function.name;
            }
            if (delta.function?.arguments) {
                entry.args += delta.function.arguments;
            }
            this.byIndex.set(delta.index, entry);
        }
    }

    finish(): StreamedToolCall[] {
        const calls: StreamedToolCall[] = [];
        for (const [index, entry] of [...this.byIndex.entries()].sort(
            (a, b) => a[0] - b[0]
        )) {
            if (!entry.name) {
                continue;
            }
            const parsed = parseToolArguments(entry.args);
            calls.push({
                // A gateway that omits the id still leaves the call usable, and
                // the index is unique within the response.
                id: entry.id || `${this.idPrefix}_${index}`,
                name: entry.name,
                input: parsed.input,
                ...(parsed.malformed
                    ? { malformedArguments: parsed.malformed }
                    : {}),
            });
        }
        return calls;
    }
}

type ParsedArguments = { input: object; malformed?: string };

/**
 * Tool arguments are a JSON string. A model can emit an unparseable fragment, in
 * which case an empty object lets the tool report a normal validation failure
 * instead of breaking the whole turn. The offending text is returned alongside
 * so the caller can log it — a silent `{}` is impossible to diagnose.
 */
function parseToolArguments(args: string): ParsedArguments {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return { input: {} };
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        // An array parses, but the tool would receive a shape its schema
        // never declared; only an object is a valid argument set.
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)
        ) {
            return { input: parsed };
        }
        return { input: {}, malformed: trimmed };
    } catch {
        return { input: {}, malformed: trimmed };
    }
}

export function parseArguments(args: string): object {
    return parseToolArguments(args).input;
}

function isAbort(error: unknown): boolean {
    return (
        error instanceof OpenAI.APIUserAbortError ||
        (error instanceof Error && error.name === 'AbortError')
    );
}

function toLanguageModelError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
        const message = `Agent Router: ${describe(error)}`;
        if (error.status === 401 || error.status === 403) {
            return vscode.LanguageModelError.NoPermissions(message);
        }
        if (error.status === 404) {
            return vscode.LanguageModelError.NotFound(message);
        }
        return new Error(message);
    }
    return error instanceof Error ? error : new Error(String(error));
}

function describe(error: unknown): string {
    if (error instanceof RequestTimeoutError) {
        return `${error.message}. The endpoint may be unreachable from this network.`;
    }
    if (error instanceof OpenAI.APIError) {
        const status = error.status ? `HTTP ${error.status}` : 'request failed';
        return `${status}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}
