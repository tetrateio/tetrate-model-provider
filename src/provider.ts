import Anthropic, {
    type ClientOptions as AnthropicClientOptions,
} from '@anthropic-ai/sdk';
import OpenAI, { type ClientOptions } from 'openai';
import * as vscode from 'vscode';

import {
    convertToAnthropic,
    convertToolChoice,
    convertToolsToAnthropic,
} from './anthropicMessages';
import { MessageStreamAccumulator } from './anthropicStream';

import {
    type CatalogModel,
    fetchApiModels,
    gatewayPricingOf,
    type ModelPricing,
    pricingOf,
    RequestTimeoutError,
    selectChatModels,
} from './catalog';
import { loadPublicCatalog, peekPublicCatalog } from './catalogCache';
import {
    getConfig,
    messagesBaseUrl,
    type ModelOverride,
    overridesFor,
    type ProviderConfig,
} from './config';
import {
    describeGateway,
    describeProvider,
    fetchGatewayStatus,
    fetchProviderReport,
} from './health';
import { convertMessages, convertToolMode, convertTools } from './messages';
import { getAnthropicKey, getApiKey, promptForApiKey } from './secrets';
import { countTokens } from './tokenCount';
import {
    ActivityTracker,
    formatCost,
    formatTokens,
    type RequestUsage,
    UsageTracker,
} from './usage';

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
 * The header the gateway reads the Agent Router key from on the passthrough
 * path, where `x-api-key` carries the caller's own Anthropic credential.
 */
export const TARS_KEY_HEADER = 'x-tars-api-key';

/**
 * `max_tokens` is mandatory on the Messages API. With no override, the model's
 * advertised output budget is sent, capped so an oversized catalog figure does
 * not reserve more than a normal answer needs.
 */
const PASSTHROUGH_MAX_TOKENS_CAP = 32_000;

/**
 * Whether a model can take the passthrough path. Passthrough forwards an
 * Anthropic credential to an Anthropic API, so only Anthropic models qualify;
 * every other model keeps the managed path even with passthrough enabled.
 */
export function isAnthropicModel(model: {
    id: string;
    family?: string;
}): boolean {
    return model.family === 'anthropic' || /claude|anthropic/i.test(model.id);
}

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

    /** In-flight requests, for a live activity indicator. */
    readonly activity = new ActivityTracker();

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

    /** The Anthropic passthrough key, cached and dropped the same way. */
    private anthropicKeyCache?: { value: string | undefined };

    private changeTimer?: ReturnType<typeof setTimeout>;

    /** Disambiguates synthesized tool-call ids across turns; see finish(). */
    private turn = 0;

    /** One id per window for the opt-in attribution header; see client(). */
    private readonly sessionId = crypto.randomUUID();

    /** Bounds the failure triage to one health round per window per burst. */
    private lastTriageAt = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: vscode.LogOutputChannel,
        /** Lets tests substitute a scripted client; production uses the SDK. */
        private readonly createClient: (options: ClientOptions) => OpenAI = (
            options
        ) => new OpenAI(options),
        /** Lets tests substitute a scripted Messages client for passthrough. */
        private readonly createAnthropicClient: (
            options: AnthropicClientOptions
        ) => Anthropic = (options) => new Anthropic(options),
        /** Injectable so unit tests never reach the network for triage. */
        private readonly health = {
            gateway: fetchGatewayStatus,
            providers: fetchProviderReport,
        }
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
        this.anthropicKeyCache = undefined;

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
        // Passthrough changes what the picker says about Anthropic models, so
        // it is part of the key; a stored Anthropic key is too, since without
        // one those models stay on the managed path.
        const passthrough =
            config.passthroughEnabled &&
            (await this.passthroughKeyFor(config)) !== undefined;
        const cacheKey = `${config.baseUrl}|${config.modelFilter.join(',')}|${passthrough}`;
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

        const promise = this.discover(
            config,
            apiKey,
            cacheKey,
            options,
            token,
            passthrough
        );
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
        token: vscode.CancellationToken,
        passthrough: boolean
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

            const models = selectChatModels(apiModels, catalog, config).map(
                (model) =>
                    passthrough && isAnthropicModel(model)
                        ? markPassthrough(model)
                        : model
            );
            // Gateway-reported prices are per key and win over the public
            // catalog; the catalog still prices models on gateways that do
            // not enrich their /models entries.
            this.pricingById = indexPricing(catalog.values());
            for (const apiModel of apiModels) {
                const pricing = gatewayPricingOf(apiModel);
                if (pricing) {
                    this.pricingById.set(apiModel.id.toLowerCase(), pricing);
                }
            }
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

        const requestId = crypto.randomUUID();
        // Both protocols drop the same parts, so the OpenAI conversion
        // answers "is there anything to send" for either.
        if (convertMessages(messages).length === 0) {
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

        const activityHandle = this.activity.begin(model.id);
        // Called after every chunk: armed after the chunk is handled so the
        // allowance measures the gap to the next one. Role-only and reasoning
        // chunks keep the longer allowance, since the model has not started
        // answering yet.
        let firstOutputAt: number | undefined;
        const onChunk = (outputStarted: boolean) => {
            if (outputStarted && firstOutputAt === undefined) {
                firstOutputAt = Date.now();
                this.activity.markOutput(activityHandle);
            }
            armIdleTimer(outputStarted ? 'idle' : 'first');
        };
        const passthrough = await this.passthroughKey(config, model);
        try {
            const startedAt = Date.now();
            armIdleTimer('first');
            const streamed = passthrough
                ? await this.streamMessages(
                      config,
                      apiKey,
                      passthrough,
                      model,
                      messages,
                      options,
                      requestId,
                      controller.signal,
                      progress,
                      onChunk
                  )
                : await this.streamChatCompletions(
                      config,
                      apiKey,
                      model,
                      messages,
                      options,
                      requestId,
                      controller.signal,
                      progress,
                      onChunk
                  );

            // Both SDKs' iterators return quietly on the abort they see
            // mid-stream, so a stall or a cancellation ends the loop as
            // though the answer were complete.
            if (stalled) {
                throw stalled;
            }
            if (token.isCancellationRequested) {
                return;
            }

            // Silent capability loss is the docs' stated risk of crossing
            // providers; the gateway names what it removed, so say so.
            if (streamed.droppedFields) {
                this.log.warn(
                    `${model.id}: the gateway dropped request fields crossing providers: ${streamed.droppedFields}`
                );
            }

            // Arguments arrive as string fragments, so a call is only
            // reportable once the stream has finished delivering it.
            for (const call of streamed.calls) {
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
                streamed.finishReason,
                streamed.reportedText,
                streamed.calls.length,
                progress
            );
            this.recordUsage(
                model.id,
                streamed.usage,
                {
                    startedAt,
                    firstOutputAt,
                    finishedAt: Date.now(),
                },
                streamed.finishReason,
                requestId,
                streamed.servedBy,
                passthrough !== undefined
            );
        } catch (error) {
            if (stalled) {
                this.log.error(stalled.message);
                void this.triage(config, apiKey);
                throw stalled;
            }
            if (isAbort(error) || token.isCancellationRequested) {
                return;
            }
            this.log.error(
                `Request to ${model.id}${passthrough ? ' (passthrough)' : ''} failed: ${describe(error)}`
            );
            void this.triage(config, apiKey);
            this.offerRetryHint(error, model.id);
            throw toLanguageModelError(error, passthrough !== undefined);
        } finally {
            this.activity.end(activityHandle);
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            cancellation.dispose();
        }
    }

    /**
     * The Anthropic key to pass through for this request, or undefined when
     * the request takes the managed path: passthrough off, a non-Anthropic
     * model, or no key stored for the endpoint.
     */
    private async passthroughKey(
        config: ProviderConfig,
        model: vscode.LanguageModelChatInformation
    ): Promise<string | undefined> {
        if (!config.passthroughEnabled || !isAnthropicModel(model)) {
            return undefined;
        }
        return this.passthroughKeyFor(config);
    }

    private async passthroughKeyFor(
        config: ProviderConfig
    ): Promise<string | undefined> {
        if (!this.anthropicKeyCache) {
            this.anthropicKeyCache = {
                value: await getAnthropicKey(this.context, config.baseUrl),
            };
        }
        return this.anthropicKeyCache.value;
    }

    /**
     * The passthrough path: the Anthropic Messages API on the same gateway,
     * with the user's own Anthropic key in `x-api-key`, which the gateway
     * forwards upstream untouched, and the Agent Router key in
     * `x-tars-api-key` for routing and attribution only. Anthropic bills the
     * key's owner; the gateway logs the request as `passthrough`.
     */
    private async streamMessages(
        config: ProviderConfig,
        apiKey: string,
        anthropicKey: string,
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        requestId: string,
        signal: AbortSignal,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        onChunk: (outputStarted: boolean) => void
    ): Promise<StreamResult> {
        const conversation = convertToAnthropic(messages);
        const tools = convertToolsToAnthropic(options.tools);
        const override = overridesFor(model.id, config.modelOverrides);
        const client = this.createAnthropicClient({
            apiKey: anthropicKey,
            // Explicitly null: the SDK otherwise reads ANTHROPIC_AUTH_TOKEN
            // from the environment and would send a second credential.
            authToken: null,
            baseURL: messagesBaseUrl(config.baseUrl),
            timeout: RESPONSE_TIMEOUT_MS,
            maxRetries: 2,
            defaultHeaders: this.defaultHeaders(config, {
                [TARS_KEY_HEADER]: apiKey,
            }),
        });

        const request = client.messages.create(
            {
                // Same precedence as the managed path: caller options first,
                // then the user's overrides, then the fields the response
                // handling depends on.
                ...((options.modelOptions ?? {}) as Record<string, unknown>),
                ...(override.temperature !== undefined
                    ? { temperature: Math.min(override.temperature, 1) }
                    : {}),
                model: model.id,
                max_tokens:
                    override.maxTokens ??
                    numberOption(options.modelOptions, 'max_tokens') ??
                    Math.min(model.maxOutputTokens, PASSTHROUGH_MAX_TOKENS_CAP),
                messages: conversation.messages,
                ...(conversation.system ? { system: conversation.system } : {}),
                stream: true,
                ...(tools
                    ? { tools, tool_choice: convertToolChoice(options.toolMode) }
                    : {}),
            } as Anthropic.Messages.MessageCreateParamsStreaming,
            { signal, headers: { 'X-Request-ID': requestId } }
        );

        let responseHeaders: Headers | undefined;
        const stream = await (async () => {
            const withResponse = (
                request as {
                    withResponse?: () => Promise<{
                        data: Awaited<typeof request>;
                        response: { headers: Headers };
                    }>;
                }
            ).withResponse;
            if (typeof withResponse === 'function') {
                const result = await withResponse.call(request);
                responseHeaders = result.response.headers;
                return result.data;
            }
            return request;
        })();

        const accumulator = new MessageStreamAccumulator();
        let reportedText = 0;
        for await (const event of stream) {
            for (const output of accumulator.handle(event)) {
                reportedText += output.text.length;
                progress.report(new vscode.LanguageModelTextPart(output.text));
            }
            onChunk(accumulator.outputStarted);
        }

        const served = accumulator.servedModel;
        return {
            finishReason: accumulator.finishReasonForOpenAI(),
            servedBy: served && served !== model.id ? served : undefined,
            usage: accumulator.usage(),
            reportedText,
            calls: accumulator.finish(),
            droppedFields:
                responseHeaders?.get('x-tars-dropped-fields') ?? undefined,
        };
    }

    /**
     * The managed path: OpenAI chat completions, authenticated with the Agent
     * Router key and billed to the Agent Router account.
     */
    private async streamChatCompletions(
        config: ProviderConfig,
        apiKey: string,
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        requestId: string,
        signal: AbortSignal,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        onChunk: (outputStarted: boolean) => void
    ): Promise<StreamResult> {
        const chatMessages = convertMessages(messages, {
            toolResultImages: model.capabilities?.imageInput === true,
        });
        const tools = convertTools(options.tools);
        const override = overridesFor(model.id, config.modelOverrides);
        const pending = this.client(config, apiKey).chat.completions.create(
            {
                // Callers may pass provider-specific knobs such as
                // temperature, max_tokens or reasoning_effort straight
                // through. Spread first so the fields below cannot be
                // overridden — clobbering `stream` or `messages` would break
                // the response handling outright. The per-model overrides
                // sit in between: they are the user's own setting, so they
                // outrank a calling extension's defaults.
                ...(options.modelOptions ?? {}),
                ...overrideParams(override),
                model: model.id,
                messages: chatMessages,
                stream: true,
                // Asks for billed token counts on a final chunk that carries
                // an empty `choices` array.
                stream_options: { include_usage: true },
                ...(tools
                    ? {
                          tools,
                          tool_choice: convertToolMode(options.toolMode),
                      }
                    : {}),
            },
            {
                signal,
                headers: {
                    // Echoed back as x-client-request-id and indexed by the
                    // service's Request Logs, so one id correlates the local
                    // record with the server-side one.
                    'X-Request-ID': requestId,
                    // A reasoning-effort override marks the model as
                    // reasoning-capable for this call, so the gateway does not
                    // strip thinking fields toward an OpenAI-shaped backend
                    // the catalog mislabels.
                    ...(override.reasoningEffort !== undefined
                        ? { 'x-tars-supports-reasoning': 'true' }
                        : {}),
                },
            }
        );

        // withResponse() exposes the response headers, where the gateway
        // names any fields it dropped translating across providers. The
        // fallback path keeps scripted test clients working.
        let responseHeaders: Headers | undefined;
        const stream = await (async () => {
            const withResponse = (
                pending as {
                    withResponse?: () => Promise<{
                        data: Awaited<typeof pending>;
                        response: { headers: Headers };
                    }>;
                }
            ).withResponse;
            if (typeof withResponse === 'function') {
                const result = await withResponse.call(pending);
                responseHeaders = result.response.headers;
                return result.data;
            }
            return pending;
        })();

        const toolCalls = new ToolCallAccumulator(`call_${this.turn++}`);
        let finishReason: string | undefined;
        let servedBy: string | undefined;
        let usage: OpenAI.Completions.CompletionUsage | undefined;
        let reportedText = 0;
        let outputStarted = false;

        // A chunk carrying an `error` field never reaches this loop: the SDK
        // raises it as an APIError before yielding.
        for await (const chunk of stream) {
            if (chunk.usage) {
                usage = chunk.usage;
            }
            // The response names the backend that actually answered, which
            // differs from the requested id under fallback routing or a
            // model-name override on the key.
            if (chunk.model && chunk.model !== model.id) {
                servedBy = chunk.model;
            }
            const choice = chunk.choices[0];
            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }

            const delta = choice?.delta;
            if (delta?.content) {
                reportedText += delta.content.length;
                progress.report(new vscode.LanguageModelTextPart(delta.content));
                outputStarted = true;
            }
            if (delta?.tool_calls?.length) {
                toolCalls.add(delta.tool_calls);
                outputStarted = true;
            }
            onChunk(outputStarted);
        }

        return {
            finishReason,
            servedBy,
            usage: usage
                ? {
                      inputTokens: usage.prompt_tokens ?? 0,
                      cachedInputTokens:
                          usage.prompt_tokens_details?.cached_tokens ?? 0,
                      outputTokens: usage.completion_tokens ?? 0,
                      reasoningTokens:
                          usage.completion_tokens_details?.reasoning_tokens ??
                          0,
                  }
                : undefined,
            reportedText,
            calls: toolCalls.finish(),
            droppedFields:
                responseHeaders?.get('x-tars-dropped-fields') ?? undefined,
        };
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
     * Books the billed counts from the stream's usage block and logs one
     * completion line with the request timing. A gateway that ignores
     * `stream_options` sends no usage, which is booked as nothing rather than
     * as a zero-token request; the timing is still logged.
     */
    private recordUsage(
        modelId: string,
        request: RequestUsage | undefined,
        timing: RequestTiming,
        finishReason: string | undefined,
        requestId: string,
        servedBy: string | undefined,
        passthrough: boolean
    ): void {
        if (!request) {
            this.log.info(
                `${modelId}: completed (${describeTiming(timing)}); no usage block received · ${requestId}`
            );
            return;
        }
        // The answering backend's price is the one that was charged; the
        // requested id keeps the aggregation key so a model's totals stay in
        // one row even when some requests fell back.
        const pricing = servedBy
            ? (this.pricingFor(servedBy) ?? this.pricingFor(modelId))
            : this.pricingFor(modelId);
        const cost = this.usage.record(modelId, request, pricing, {
            durationMs: timing.finishedAt - timing.startedAt,
            firstOutputMs:
                timing.firstOutputAt !== undefined
                    ? timing.firstOutputAt - timing.startedAt
                    : undefined,
            finishReason,
            requestId,
            ...(servedBy ? { servedBy } : {}),
            ...(passthrough ? { passthrough: true } : {}),
        });

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
                cost !== undefined
                    ? ` ≈ ${formatCost(cost)}${passthrough ? ' at API rates, billed by Anthropic' : ''}`
                    : ''
            }${passthrough ? ' · passthrough' : ''}${servedBy ? ` · served by ${servedBy}` : ''} (${describeTiming(timing)}) · ${requestId}`
        );
    }

    /**
     * The docs' outage triage, run automatically when a request fails: the
     * status document tells a gateway problem from everything else, and the
     * provider report names an upstream that is failing. Logged rather than
     * toasted, because the chat view already shows the request's own error;
     * bounded to one round per burst so a failing loop does not add load.
     */
    private async triage(
        config: ProviderConfig,
        apiKey: string
    ): Promise<void> {
        const now = Date.now();
        if (now - this.lastTriageAt < 30_000) {
            return;
        }
        this.lastTriageAt = now;
        try {
            const gateway = await this.health.gateway(config.baseUrl);
            this.log.info(`Triage: gateway ${describeGateway(gateway)}`);
            if (!gateway.reachable || gateway.status === 'not_serving') {
                this.log.info(
                    'Triage: the gateway itself is the problem; this is not the API key or the request.'
                );
                return;
            }
            const report = await this.health.providers(
                config.baseUrl,
                apiKey,
                config.requestHeaders
            );
            if (!report) {
                this.log.info(
                    'Triage: this gateway serves no provider report (/v1/status).'
                );
                return;
            }
            const failing = report.providers.filter(
                (provider) => provider.reachable === false
            );
            for (const provider of failing) {
                this.log.warn(
                    `Triage: provider ${provider.name} ${describeProvider(provider)} — the failure was likely provider-side.`
                );
            }
            if (failing.length === 0) {
                this.log.info(
                    'Triage: gateway serving, no provider failing in the observation window.'
                );
            }
        } catch {
            // Triage must never add a second failure to the first.
        }
    }

    /**
     * `model_not_ready` is the one error whose fix is purely waiting, so it
     * gets a toast with the gateway's own suggested delay. Once per model per
     * window: propagation takes seconds, not sessions.
     */
    private readonly retryHinted = new Set<string>();
    private offerRetryHint(error: unknown, modelId: string): void {
        if (
            !(error instanceof OpenAI.APIError) &&
            !(error instanceof Anthropic.APIError)
        ) {
            return;
        }
        const body = error.error as
            | { code?: string; error?: { code?: string } }
            | undefined;
        const code =
            ('code' in error ? (error.code as string | null | undefined) : undefined) ??
            body?.code ??
            body?.error?.code;
        if (code !== 'model_not_ready' || this.retryHinted.has(modelId)) {
            return;
        }
        this.retryHinted.add(modelId);
        const after = error.headers?.get?.('retry-after');
        const showStatus = 'Show Connection Status';
        void vscode.window
            .showWarningMessage(
                `Agent Router: ${modelId} is provisioned but not active yet. The gateway suggests retrying in ${after ?? 'a few'}s.`,
                showStatus
            )
            .then((action) =>
                action === showStatus
                    ? vscode.commands.executeCommand(
                          'tetrate-model-provider.showStatus'
                      )
                    : undefined
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
            defaultHeaders: this.defaultHeaders(config),
        });
    }

    /**
     * Headers both protocols send. Credentials are applied last, so a
     * configured request header can never replace one; getConfig already
     * strips such entries.
     */
    private defaultHeaders(
        config: ProviderConfig,
        credentials: Record<string, string> = {}
    ): Record<string, string> {
        return {
            'User-Agent': USER_AGENT,
            // The gateway records custom headers as OpenTelemetry span
            // attributes, so this groups one window's traffic in the
            // Console's traces. Opt-in: it sends a new identifier off the
            // machine, even if only a random one.
            ...(config.sessionAttribution
                ? { 'agent-session-id': this.sessionId }
                : {}),
            ...config.requestHeaders,
            ...credentials,
        };
    }

    private async reportListFailure(error: unknown): Promise<void> {
        const setKey = 'Set API Key';
        const setUrl = 'Set Base URL';
        const dashboard = 'Open Dashboard';
        const action = await vscode.window.showErrorMessage(
            `Tetrate Agent Router: could not list models. ${describe(error)}`,
            setKey,
            setUrl,
            dashboard
        );
        if (action === setKey) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setApiKey'
            );
        } else if (action === setUrl) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setBaseUrl'
            );
        } else if (action === dashboard) {
            await vscode.env.openExternal(
                vscode.Uri.parse('https://router.tetrate.ai/')
            );
        }
    }
}

/**
 * Names the billing path where the model is chosen: a passthrough model is
 * paid for by the user's own Anthropic account, which the picker must not
 * leave to be discovered on an invoice.
 */
function markPassthrough(
    model: vscode.LanguageModelChatInformation
): vscode.LanguageModelChatInformation {
    return {
        ...model,
        detail: `${model.detail ?? 'Agent Router'} · passthrough`,
        tooltip: [
            model.tooltip,
            'Passthrough: sent with your own Anthropic API key and billed by Anthropic; Agent Router routes and logs it.',
        ]
            .filter(Boolean)
            .join('\n'),
    };
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
        ...(override.maxTokens !== undefined
            ? { max_tokens: override.maxTokens }
            : {}),
    };
}

/** What either protocol's stream loop hands back to the shared wrapper. */
type StreamResult = {
    /** In the OpenAI vocabulary, whichever protocol answered. */
    finishReason: string | undefined;
    servedBy: string | undefined;
    usage: RequestUsage | undefined;
    reportedText: number;
    calls: StreamedToolCall[];
    droppedFields: string | undefined;
};

/** Request timing for the completion log line. */
type RequestTiming = {
    startedAt: number;
    firstOutputAt: number | undefined;
    finishedAt: number;
};

function describeTiming(timing: RequestTiming): string {
    const total = seconds(timing.finishedAt - timing.startedAt);
    return timing.firstOutputAt !== undefined
        ? `first output ${seconds(timing.firstOutputAt - timing.startedAt)}, total ${total}`
        : `total ${total}`;
}

function seconds(ms: number): string {
    return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
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

/** A number-valued caller option, when the caller supplied one. */
function numberOption(
    modelOptions: { readonly [name: string]: unknown } | undefined,
    name: string
): number | undefined {
    const value = modelOptions?.[name];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

function isAbort(error: unknown): boolean {
    return (
        error instanceof OpenAI.APIUserAbortError ||
        error instanceof Anthropic.APIUserAbortError ||
        (error instanceof Error && error.name === 'AbortError')
    );
}

function toLanguageModelError(error: unknown, passthrough = false): Error {
    if (error instanceof Anthropic.APIError) {
        const message = `Agent Router passthrough: ${describe(error)}`;
        if (error.status === 401 || error.status === 403) {
            return vscode.LanguageModelError.NoPermissions(message);
        }
        if (error.status === 404) {
            return vscode.LanguageModelError.NotFound(message);
        }
        return new Error(message);
    }
    if (error instanceof OpenAI.APIError) {
        const message = `Agent Router${passthrough ? ' passthrough' : ''}: ${describe(error)}`;
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
    if (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError) {
        const status = error.status ? `HTTP ${error.status}` : 'request failed';
        const advice = adviceFor(error);
        return `${status}: ${error.message}${advice ? ` — ${advice}` : ''}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Turns the gateway's documented error signals into the sentence that names
 * the fix. The signals are precise — a budget block and a rate limit share
 * status 429 and are told apart only by a header, and four distinct `code`
 * values describe where in its lifecycle a missing model is — so without
 * this, every one of them reads as the same opaque failure.
 */
export function adviceFor(
    error: InstanceType<typeof OpenAI.APIError> | InstanceType<typeof Anthropic.APIError>
): string | undefined {
    // The gateway's own fields sit at the top level of an OpenAI-shaped body
    // and under `error` in an Anthropic-shaped one.
    const raw = (error.error ?? {}) as { error?: object };
    const body = {
        ...raw,
        ...(raw.error && typeof raw.error === 'object' ? raw.error : {}),
    } as {
        code?: string;
        category?: string;
        your_hostnames?: string[];
        type?: string;
    };
    const passthrough = error instanceof Anthropic.APIError;

    if (passthrough && error.status === 401) {
        // On the passthrough path a 401 comes from Anthropic, forwarded:
        // the Agent Router key travels separately in x-tars-api-key.
        return 'Anthropic rejected the passthrough API key. Run "Tetrate Agent Router: Set Anthropic API Key for Passthrough" with a valid key from the Claude Console.';
    }

    if (error.status === 429) {
        // The gateway marks a budget stop explicitly; a plain 429 is a rate
        // limit and worth retrying, which a budget stop never is.
        return error.headers?.get?.('x-tars-budget-action') === 'block'
            ? 'A spend budget blocked this request; this is not a rate limit, and retrying will not help until the budget resets.'
            : 'Rate limited; retry shortly.';
    }

    if (error.status === 403 && body.category === 'hostname_not_selected') {
        const hosts = (body.your_hostnames ?? []).join(', ');
        return `This API key belongs to a different gateway host${hosts ? ` (${hosts})` : ''}. Run "Tetrate Agent Router: Switch Endpoint".`;
    }

    const code =
        ('code' in error ? (error.code as string | null | undefined) : undefined) ??
        body.code;
    switch (code) {
        case 'model_not_found':
            return 'The model is not in the catalog for this key, or is disabled.';
        case 'model_not_available':
            return 'The model is enabled but still propagating to the gateway; retry in a moment.';
        case 'model_not_ready': {
            const after = error.headers?.get?.('retry-after');
            return `The model's route is provisioned but not active yet; retry${after ? ` in ${after}s` : ' shortly'}.`;
        }
        case 'model_not_routed':
            return "The model is enabled but has no route on this gateway; check the project's model grants.";
        default:
            return undefined;
    }
}
