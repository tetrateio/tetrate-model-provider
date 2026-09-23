import * as vscode from 'vscode';

import {
    isIncludedByFilter,
    type ModelOverride,
    overridesFor,
    type ProviderConfig,
} from './config';

/** One entry of `GET {baseUrl}/models`, which is OpenAI-shaped. */
export type ApiModel = {
    id: string;
    object?: string;
    owned_by?: string;
    created?: number;
};

/**
 * One entry of the public Agent Router catalog. The OpenAI-compatible
 * `/models` route only reports ids, so the numbers VS Code needs — context
 * window, output cap, vision and tool support — come from here.
 */
export type CatalogModel = {
    model: string;
    provider?: string;
    displayName?: string;
    mode?: string;
    isEnabled?: boolean;
    contextWindow?: number;
    capabilities?: string[];
    modalities?: { input?: string[]; output?: string[] };
    limits?: { max_output_tokens?: number };
    metadata?: { description?: string; display_name?: string };
    // The live catalog serves prices as decimal strings; the local cache
    // stores them re-encoded as numbers. parsePrice() accepts both.
    inputTokensPricePer1M?: string | number;
    outputTokensPricePer1M?: string | number;
    cachedTokensPricePer1M?: string | number;
};

/** Catalog prices in dollars per million tokens, parsed and validated. */
export type ModelPricing = {
    inputPer1M: number;
    outputPer1M: number;
    cachedPer1M?: number;
};

export const PUBLIC_CATALOG_URL =
    'https://router.tetrate.ai/api/public/models';

/**
 * Bounds how many catalog pages one refresh will follow. The live catalog fits
 * in a single page of 500 today, so this only bites if `totalPages` ever comes
 * back runaway or malicious.
 */
export const MAX_CATALOG_PAGES = 10;

/**
 * Used when the catalog has nothing to say about a model — deliberately modest,
 * because an overstated context window turns into a mid-conversation API error
 * while an understated one only costs some unused headroom.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Floors for the two budgets. A model whose advertised context window is
 * smaller than these is unusable anyway; reporting zero or a negative number
 * would break VS Code's budgeting rather than degrade it.
 */
export const MIN_INPUT_TOKENS = 1024;
export const MIN_OUTPUT_TOKENS = 256;

/**
 * `/models` gates the whole model picker, so it gets a real budget and a retry.
 *
 * The public catalog only supplies nice-to-have metadata and is allowed to
 * lose — {@link FALLBACK_CONTEXT_WINDOW} and its siblings exist precisely so
 * discovery never waits on it. Its budget is nonetheless generous, because the
 * two run in parallel: anything at or below the `/models` allowance costs no
 * wall-clock, and a cold fetch of the live catalog measures around a second.
 */
export const MODELS_TIMEOUT_MS = 15_000;
export const MODELS_ATTEMPTS = 3;
export const CATALOG_TIMEOUT_MS = 8_000;
export const CATALOG_ATTEMPTS = 1;

/** Statuses worth a second try: transient by definition, and this is a GET. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const NON_CHAT_ID_PATTERN =
    /(^|[-/])(embed|embedding|rerank|moderation|whisper|tts|dall-e|image|vision-encoder)([-.]|$)/i;

/**
 * Catalog `mode` values that cannot answer a conversational request.
 *
 * Note that `responses` is *not* one of them: it records that the upstream
 * provider's native API is OpenAI's Responses API, which is how every OpenAI
 * model is listed. The Agent Router still exposes those models over the
 * OpenAI-compatible chat-completions route, so excluding them would drop the
 * entire OpenAI line-up. Unknown modes are treated as usable for the same
 * reason.
 */
const NON_CONVERSATIONAL_MODES = new Set([
    'embedding',
    'image_generation',
    'rerank',
    'moderation',
    'audio_transcription',
    'audio_speech',
]);

/**
 * A request that ran out of time rather than being cancelled by the user. The
 * distinction matters upstream: a cancellation is silent, a timeout is
 * something the user needs told about.
 */
export class RequestTimeoutError extends Error {
    constructor(
        readonly url: string,
        readonly timeoutMs: number
    ) {
        super(`GET ${url} timed out after ${timeoutMs} ms`);
        this.name = 'RequestTimeoutError';
    }
}

export async function fetchApiModels(
    baseUrl: string,
    apiKey: string,
    headers: Record<string, string>,
    token?: vscode.CancellationToken
): Promise<ApiModel[]> {
    const url = `${baseUrl}/models`;
    const response = await request(
        url,
        {
            ...headers,
            Authorization: `Bearer ${apiKey}`,
        },
        {
            timeoutMs: MODELS_TIMEOUT_MS,
            attempts: MODELS_ATTEMPTS,
            token,
        }
    );

    if (!response.ok) {
        throw new Error(
            `Agent Router returned ${response.status} ${response.statusText} for GET ${url}${await describeErrorBody(response)}`
        );
    }

    const body = await readJson<{ data?: ApiModel[] }>(response, url);
    return (body.data ?? []).filter(
        (model): model is ApiModel => typeof model?.id === 'string'
    );
}

/**
 * Best-effort metadata lookup. The catalog is public and unauthenticated, and a
 * self-hosted deployment may not be represented in it at all, so every failure
 * here degrades to fallback numbers instead of breaking model discovery.
 *
 * The endpoint paginates. The first page reports `totalPages`; any further
 * pages (up to {@link MAX_CATALOG_PAGES}) are fetched in parallel and joined
 * in page order, so growth past the server's page size does not silently drop
 * the tail of the catalog.
 *
 * Returns undefined, rather than an empty list, when the fetch did not
 * succeed, so a caller holding a stale copy can tell "the catalog is empty"
 * from "we could not reach the catalog" and keep serving what it has. Any one
 * page failing fails the whole call for the same reason: a partial catalog
 * would replace a complete stale copy with a worse one.
 */
export async function fetchPublicCatalogModels(
    token?: vscode.CancellationToken
): Promise<CatalogModel[] | undefined> {
    try {
        const first = await fetchCatalogPage(1, token);
        const lastPage = Math.min(
            clampPositive(first.totalPages, 1),
            MAX_CATALOG_PAGES
        );
        const rest = await Promise.all(
            Array.from({ length: Math.max(0, lastPage - 1) }, (_, i) =>
                fetchCatalogPage(i + 2, token)
            )
        );
        return [first, ...rest]
            .flatMap((page) => page.models ?? [])
            .filter(
                (model): model is CatalogModel =>
                    typeof model?.model === 'string'
            );
    } catch {
        // Discovery must still work offline or behind a proxy that blocks this
        // host; the caller falls back to a stale copy or to the defaults.
        return undefined;
    }
}

type CatalogPage = {
    models?: CatalogModel[];
    totalPages?: number;
};

/**
 * One page of the catalog. A non-2xx status throws rather than returning an
 * empty page, so it surfaces through `Promise.all` the same way a network
 * error or a timeout does.
 */
async function fetchCatalogPage(
    page: number,
    token?: vscode.CancellationToken
): Promise<CatalogPage> {
    const url = `${PUBLIC_CATALOG_URL}?limit=500${page > 1 ? `&page=${page}` : ''}`;
    const response = await request(
        url,
        {},
        {
            timeoutMs: CATALOG_TIMEOUT_MS,
            attempts: CATALOG_ATTEMPTS,
            token,
        }
    );
    if (!response.ok) {
        throw new Error(
            `Agent Router returned ${response.status} ${response.statusText} for GET ${url}`
        );
    }
    return readJson<CatalogPage>(response, url);
}

/** Convenience wrapper that fetches and indexes in one step. */
export async function fetchPublicCatalog(
    token?: vscode.CancellationToken
): Promise<Map<string, CatalogModel>> {
    return indexCatalog(await fetchPublicCatalogModels(token));
}

/** Model ids are compared case-insensitively; the catalog is not consistent. */
export function indexCatalog(
    models: readonly CatalogModel[] | undefined
): Map<string, CatalogModel> {
    const byId = new Map<string, CatalogModel>();
    for (const model of models ?? []) {
        if (typeof model?.model === 'string') {
            byId.set(model.model.toLowerCase(), model);
        }
    }
    return byId;
}

/**
 * Reads a catalog price. Prices arrive as decimal strings from the live
 * catalog and as numbers from the local cache; anything negative or
 * unparseable reads as absent, since a wrong price is worse than none.
 */
export function parsePrice(
    value: string | number | undefined
): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Returns pricing only when both directions are known. Cost arithmetic with a
 * missing half would understate every request, which is worse than reporting
 * the price as unknown.
 */
export function pricingOf(
    catalogModel: CatalogModel | undefined
): ModelPricing | undefined {
    const inputPer1M = parsePrice(catalogModel?.inputTokensPricePer1M);
    const outputPer1M = parsePrice(catalogModel?.outputTokensPricePer1M);
    if (inputPer1M === undefined || outputPer1M === undefined) {
        return undefined;
    }
    const cachedPer1M = parsePrice(catalogModel?.cachedTokensPricePer1M);
    return {
        inputPer1M,
        outputPer1M,
        ...(cachedPer1M !== undefined ? { cachedPer1M } : {}),
    };
}

/** `$2`, `$0.25`, `$0.075`: dollars per million tokens without noise digits. */
export function formatPrice(perMillion: number): string {
    return `$${Number(perMillion.toFixed(4))}`;
}

export function toChatInformation(
    apiModel: ApiModel,
    catalogModel: CatalogModel | undefined,
    override: ModelOverride = {}
): vscode.LanguageModelChatInformation {
    // A user override outranks the catalog: it exists for models the catalog
    // does not describe, or describes wrongly for a given deployment.
    const declaredOutput = clampPositive(
        override.maxOutputTokens ?? catalogModel?.limits?.max_output_tokens,
        FALLBACK_MAX_OUTPUT_TOKENS
    );
    const contextWindow = clampPositive(
        override.contextWindow ?? catalogModel?.contextWindow,
        FALLBACK_CONTEXT_WINDOW
    );

    // VS Code budgets input separately from output, but the API charges both
    // against one context window, so the output figure is reserved up front.
    // The reservation is capped at half the window. The provider never sends
    // `max_tokens`, so the catalog's output cap is informational and
    // over-reserving it buys nothing, while a model that reports an output cap
    // as large as its context (gpt-4, the gpt-oss line) would otherwise be
    // left with a prompt budget too small to hold a single chat turn.
    const reservedOutput = Math.min(
        declaredOutput,
        Math.floor(contextWindow / 2)
    );
    const maxInputTokens = Math.max(
        MIN_INPUT_TOKENS,
        contextWindow - reservedOutput
    );

    // The floor above can still push the pair past the window on a context
    // smaller than twice the floor. Output yields, since an over-reserved
    // prompt budget is what produces a hard API error.
    const maxOutputTokens = Math.max(
        MIN_OUTPUT_TOKENS,
        Math.min(declaredOutput, contextWindow - maxInputTokens)
    );

    const capabilities = catalogModel?.capabilities ?? [];
    const inputModalities = catalogModel?.modalities?.input ?? [];
    const provider = catalogModel?.provider ?? apiModel.owned_by;

    // Cost is the axis the Agent Router routes on, so the picker shows it
    // where the models are compared instead of leaving it on the dashboard.
    const pricing = pricingOf(catalogModel);
    const priceLabel = pricing
        ? `${formatPrice(pricing.inputPer1M)}/${formatPrice(pricing.outputPer1M)} per 1M`
        : undefined;

    const detail = [
        provider ? `Agent Router · ${provider}` : 'Agent Router',
        ...(priceLabel ? [priceLabel] : []),
    ].join(' · ');

    const tooltip = [
        catalogModel?.metadata?.description ??
            `${apiModel.id} via Tetrate Agent Router Service`,
        ...(pricing
            ? [
                  `Input ${formatPrice(pricing.inputPer1M)}, output ${formatPrice(pricing.outputPer1M)} per million tokens.`,
              ]
            : []),
        ...(capabilities.includes('reasoning') ? ['Reasoning model.'] : []),
    ].join('\n');

    return {
        id: apiModel.id,
        name:
            catalogModel?.displayName ??
            catalogModel?.metadata?.display_name ??
            apiModel.id,
        family: familyOf(apiModel.id, provider),
        version: versionOf(apiModel.id),
        detail,
        tooltip,
        maxInputTokens,
        maxOutputTokens,
        capabilities: {
            toolCalling:
                capabilities.includes('tool_choice') ||
                capabilities.includes('function_calling') ||
                capabilities.length === 0,
            imageInput:
                capabilities.includes('vision') ||
                inputModalities.includes('image'),
        },
    };
}

export function selectChatModels(
    apiModels: ApiModel[],
    catalog: Map<string, CatalogModel>,
    config: Pick<ProviderConfig, 'modelFilter'> &
        Partial<Pick<ProviderConfig, 'modelOverrides'>>
): vscode.LanguageModelChatInformation[] {
    const seen = new Set<string>();
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const apiModel of apiModels) {
        if (seen.has(apiModel.id)) {
            continue;
        }
        seen.add(apiModel.id);

        const catalogModel = catalog.get(apiModel.id.toLowerCase());
        if (!isChatModel(apiModel, catalogModel)) {
            continue;
        }
        if (!isIncludedByFilter(apiModel.id, config.modelFilter)) {
            continue;
        }
        models.push(
            toChatInformation(
                apiModel,
                catalogModel,
                overridesFor(apiModel.id, config.modelOverrides ?? {})
            )
        );
    }

    return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Embedding, rerank and image-generation models are served from the same
 * endpoint but cannot answer a chat request, so offering them would only
 * produce failures. The catalog's `mode` is authoritative; the id pattern
 * covers models the catalog does not describe.
 */
export function isChatModel(
    apiModel: ApiModel,
    catalogModel: CatalogModel | undefined
): boolean {
    if (catalogModel?.mode) {
        return !NON_CONVERSATIONAL_MODES.has(catalogModel.mode);
    }
    return !NON_CHAT_ID_PATTERN.test(apiModel.id);
}

/**
 * A coarse grouping VS Code uses for `LanguageModelChatSelector.family`. The
 * provider prefix is preferred when known, since `claude-*`, `gpt-*` and
 * `gemini-*` ids all coexist behind one endpoint.
 */
export function familyOf(id: string, provider: string | undefined): string {
    if (provider && provider !== 'unknown') {
        return provider.toLowerCase();
    }
    const prefix = id.split(/[-/.]/)[0];
    return prefix ? prefix.toLowerCase() : 'tetrate';
}

/**
 * Extracts a version from ids like `claude-sonnet-4-5` (4.5),
 * `gpt-5.6-terra` (5.6) or `claude-opus-4-5-20251101` (4.5-20251101).
 */
export function versionOf(id: string): string {
    const dated = id.match(/(\d+)[-.](\d+)-(\d{8})$/);
    if (dated) {
        return `${dated[1]}.${dated[2]}-${dated[3]}`;
    }
    const trailingDate = id.match(/-(\d{8})$/);
    const twoPart = id.match(/(\d+)[-.](\d+)/);
    if (twoPart) {
        return trailingDate
            ? `${twoPart[1]}.${twoPart[2]}-${trailingDate[1]}`
            : `${twoPart[1]}.${twoPart[2]}`;
    }
    const onePart = id.match(/(\d+)/);
    return onePart?.[1] ? `${onePart[1]}.0` : '1.0';
}

function clampPositive(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}

type RequestOptions = {
    timeoutMs: number;
    attempts: number;
    token?: vscode.CancellationToken;
};

/**
 * A GET with a deadline and a bounded retry.
 *
 * The deadline is the important half: a host that accepts the connection and
 * then says nothing — a stalled proxy, a captive portal — would otherwise leave
 * the caller waiting forever, and neither `fetch` nor VS Code imposes a limit
 * of its own.
 */
async function request(
    url: string,
    headers: Record<string, string>,
    { timeoutMs, attempts, token }: RequestOptions
): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (token?.isCancellationRequested) {
            break;
        }

        try {
            const response = await attemptRequest(
                url,
                headers,
                timeoutMs,
                token
            );
            if (attempt === attempts || !RETRYABLE_STATUS.has(response.status)) {
                return response;
            }
            // Drain the body so the connection can go back to the pool, and
            // keep the status around in case this was the last useful attempt.
            const retryAfter = retryAfterMs(response);
            await response.text().catch(() => undefined);
            lastError = new Error(
                `Agent Router returned ${response.status} ${response.statusText} for GET ${url}`
            );
            await delay(retryAfter ?? backoffMs(attempt), token);
        } catch (error) {
            lastError = error;
            if (attempt === attempts || token?.isCancellationRequested) {
                throw error;
            }
            await delay(backoffMs(attempt), token);
        }
    }

    throw lastError ?? new Error(`GET ${url} was cancelled`);
}

async function attemptRequest(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    token?: vscode.CancellationToken
): Promise<Response> {
    const controller = new AbortController();
    // VS Code delivers `onCancellationRequested` asynchronously even for a
    // token that is already cancelled, so check it directly as well; otherwise
    // the request goes out before the listener ever runs.
    if (token?.isCancellationRequested) {
        controller.abort();
    }

    const timer = setTimeout(
        () => controller.abort(new RequestTimeoutError(url, timeoutMs)),
        timeoutMs
    );
    const subscription = token?.onCancellationRequested(() =>
        controller.abort()
    );

    try {
        return await fetch(url, {
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
        subscription?.dispose();
    }
}

/** Exponential with jitter, so a rate-limited window does not retry in lockstep. */
function backoffMs(attempt: number): number {
    return 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/** Honours `Retry-After` when it is present and short enough to be worth waiting. */
function retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10) {
        return undefined;
    }
    return seconds * 1000;
}

function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve) => {
        // Held in an object so `done` can reach both handles no matter which of
        // the two fires first, without either being in its temporal dead zone.
        const handles: {
            timer?: ReturnType<typeof setTimeout>;
            subscription?: vscode.Disposable;
        } = {};
        const done = () => {
            clearTimeout(handles.timer);
            handles.subscription?.dispose();
            resolve();
        };
        handles.timer = setTimeout(done, ms);
        handles.subscription = token?.onCancellationRequested(done);
    });
}

/**
 * A proxy interstitial or a misrouted path answers 200 with HTML, and the bare
 * `SyntaxError: Unexpected token '<'` that `response.json()` throws for it says
 * nothing about where it came from.
 */
async function readJson<T>(response: Response, url: string): Promise<T> {
    const text = await response.text();
    try {
        return JSON.parse(text) as T;
    } catch {
        const contentType =
            response.headers.get('content-type') ?? 'no content-type';
        const preview = text.trim().slice(0, 200) || '(empty body)';
        throw new Error(
            `Expected JSON from GET ${url} but received ${contentType}: ${preview}`
        );
    }
}

async function describeErrorBody(response: Response): Promise<string> {
    try {
        const text = (await response.text()).trim();
        return text ? `: ${text.slice(0, 500)}` : '';
    } catch {
        return '';
    }
}
