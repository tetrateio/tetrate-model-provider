import * as vscode from 'vscode';

import { isIncludedByFilter, type ProviderConfig } from './config';

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
};

export const PUBLIC_CATALOG_URL =
    'https://router.tetrate.ai/api/public/models';

/**
 * Used when the catalog has nothing to say about a model — deliberately modest,
 * because an overstated context window turns into a mid-conversation API error
 * while an understated one only costs some unused headroom.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

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

export async function fetchApiModels(
    baseUrl: string,
    apiKey: string,
    headers: Record<string, string>,
    token?: vscode.CancellationToken
): Promise<ApiModel[]> {
    const response = await request(
        `${baseUrl}/models`,
        {
            ...headers,
            Authorization: `Bearer ${apiKey}`,
        },
        token
    );

    if (!response.ok) {
        throw new Error(
            `Agent Router returned ${response.status} ${response.statusText} for GET ${baseUrl}/models${await describeErrorBody(response)}`
        );
    }

    const body = (await response.json()) as { data?: ApiModel[] };
    return (body.data ?? []).filter(
        (model): model is ApiModel => typeof model?.id === 'string'
    );
}

/**
 * Best-effort metadata lookup. The catalog is public and unauthenticated, and a
 * self-hosted deployment may not be represented in it at all, so every failure
 * here degrades to fallback numbers instead of breaking model discovery.
 */
export async function fetchPublicCatalog(
    token?: vscode.CancellationToken
): Promise<Map<string, CatalogModel>> {
    const byId = new Map<string, CatalogModel>();
    try {
        const response = await request(
            `${PUBLIC_CATALOG_URL}?limit=500`,
            {},
            token
        );
        if (!response.ok) {
            return byId;
        }
        const body = (await response.json()) as { models?: CatalogModel[] };
        for (const model of body.models ?? []) {
            if (typeof model?.model === 'string') {
                byId.set(model.model.toLowerCase(), model);
            }
        }
    } catch {
        // Discovery must still work offline or behind a proxy that blocks this
        // host; the caller falls back to conservative defaults.
    }
    return byId;
}

export function toChatInformation(
    apiModel: ApiModel,
    catalogModel: CatalogModel | undefined
): vscode.LanguageModelChatInformation {
    const maxOutputTokens = clampPositive(
        catalogModel?.limits?.max_output_tokens,
        FALLBACK_MAX_OUTPUT_TOKENS
    );
    const contextWindow = clampPositive(
        catalogModel?.contextWindow,
        FALLBACK_CONTEXT_WINDOW
    );

    // VS Code budgets input separately from output, but the API charges both
    // against one context window, so reserve the output half up front.
    const maxInputTokens = Math.max(
        1024,
        contextWindow - Math.min(maxOutputTokens, contextWindow - 1024)
    );

    const capabilities = catalogModel?.capabilities ?? [];
    const inputModalities = catalogModel?.modalities?.input ?? [];
    const provider = catalogModel?.provider ?? apiModel.owned_by;

    return {
        id: apiModel.id,
        name:
            catalogModel?.displayName ??
            catalogModel?.metadata?.display_name ??
            apiModel.id,
        family: familyOf(apiModel.id, provider),
        version: versionOf(apiModel.id),
        detail: provider ? `Agent Router · ${provider}` : 'Agent Router',
        tooltip:
            catalogModel?.metadata?.description ??
            `${apiModel.id} via Tetrate Agent Router Service`,
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
    config: Pick<ProviderConfig, 'modelFilter'>
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
        models.push(toChatInformation(apiModel, catalogModel));
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

async function request(
    url: string,
    headers: Record<string, string>,
    token?: vscode.CancellationToken
): Promise<Response> {
    const controller = new AbortController();
    const subscription = token?.onCancellationRequested(() =>
        controller.abort()
    );
    try {
        return await fetch(url, {
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
    } finally {
        subscription?.dispose();
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
