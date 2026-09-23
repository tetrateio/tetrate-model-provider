import * as vscode from 'vscode';

export const VENDOR = 'tetrate-agent-router';
export const CONFIG_SECTION = 'tetrate-model-provider';

/** Ships as the setting's default too, so both agree by construction. */
export const DEFAULT_BASE_URL = 'https://api.router.tetrate.ai/v1';

export type ProviderConfig = {
    baseUrl: string;
    modelFilter: string[];
    requestHeaders: Record<string, string>;
    modelOverrides: Record<string, ModelOverride>;
    /** Named endpoints for the Switch Endpoint command, name to base URL. */
    profiles: Record<string, string>;
    /** Dollars per day before a warning is raised; 0 disables the warning. */
    spendWarning: number;
    /** Send a per-window agent-session-id header for trace attribution. */
    sessionAttribution: boolean;
};

/** Effort levels the OpenAI protocol accepts for `reasoning_effort`. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Per-model tuning from the `modelOverrides` setting, keyed by the same glob
 * syntax as `modelFilter`. The budget fields exist for deployments the public
 * catalog does not describe, where the conservative fallbacks waste most of a
 * large context window; the request fields are defaults the user sets once
 * instead of relying on every caller to pass them.
 */
export type ModelOverride = {
    contextWindow?: number;
    maxOutputTokens?: number;
    /** A hard output cap, sent as `max_tokens`, unlike the two budget fields. */
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: ReasoningEffort;
};

export function getConfig(): ProviderConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        baseUrl: normalizeBaseUrl(config.get<string>('baseUrl')),
        modelFilter: (config.get<string[]>('modelFilter') ?? []).filter(
            (pattern) => pattern.trim().length > 0
        ),
        requestHeaders: sanitizeHeaders(
            config.get<Record<string, string>>('requestHeaders', {})
        ),
        modelOverrides: sanitizeOverrides(
            config.get<Record<string, unknown>>('modelOverrides', {})
        ),
        profiles: sanitizeProfiles(
            config.get<Record<string, unknown>>('profiles', {})
        ),
        spendWarning: sanitizeSpendWarning(config.get('spendWarning')),
        sessionAttribution: config.get('sessionAttribution') === true,
    };
}

/**
 * Profile URLs go through the same normalization as the base URL setting, so
 * a profile behaves exactly like typing its URL into Set Base URL.
 */
export function sanitizeProfiles(
    profiles: Record<string, unknown>
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, url] of Object.entries(profiles)) {
        if (name.trim().length === 0 || typeof url !== 'string') {
            continue;
        }
        if (url.trim().length === 0) {
            continue;
        }
        result[name.trim()] = normalizeBaseUrl(url);
    }
    return result;
}

function sanitizeSpendWarning(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

/**
 * `Authorization` is always derived from the key in secret storage. Letting a
 * settings value replace it would send a different credential, or none at all,
 * with nothing in the UI to show that it happened.
 */
const RESERVED_HEADERS = new Set(['authorization']);

export function sanitizeHeaders(
    headers: Record<string, string>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([name]) => !RESERVED_HEADERS.has(name.trim().toLowerCase())
        )
    );
}

/**
 * A pasted URL routinely arrives with a trailing slash, surrounding whitespace,
 * or without the `/v1` suffix the Agent Router expects. Rather than fail the
 * first request with a 404, repair the obvious cases here.
 */
export function normalizeBaseUrl(value: string | undefined): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
        return DEFAULT_BASE_URL;
    }

    const withoutTrailingSlashes = trimmed.replace(/\/+$/, '');
    if (withoutTrailingSlashes.length === 0) {
        return DEFAULT_BASE_URL;
    }

    // Only append `/v1` when no version segment is present at all; a
    // deployment pinned to some other version should be left alone.
    if (/\/v\d+$/.test(withoutTrailingSlashes)) {
        return withoutTrailingSlashes;
    }
    return `${withoutTrailingSlashes}/v1`;
}

/**
 * Settings survive hand-editing, so every field is validated rather than
 * trusted. A value that fails validation is dropped in isolation; one typo
 * must not discard the whole overrides object.
 */
export function sanitizeOverrides(
    overrides: Record<string, unknown>
): Record<string, ModelOverride> {
    const result: Record<string, ModelOverride> = {};
    for (const [pattern, raw] of Object.entries(overrides)) {
        if (
            pattern.trim().length === 0 ||
            raw === null ||
            typeof raw !== 'object' ||
            Array.isArray(raw)
        ) {
            continue;
        }
        const entry = raw as Record<string, unknown>;
        const override: ModelOverride = {
            ...pick('contextWindow', positiveInteger(entry.contextWindow)),
            ...pick('maxOutputTokens', positiveInteger(entry.maxOutputTokens)),
            ...pick('maxTokens', positiveInteger(entry.maxTokens)),
            ...pick('temperature', temperature(entry.temperature)),
            ...pick('reasoningEffort', reasoningEffort(entry.reasoningEffort)),
        };
        if (Object.keys(override).length > 0) {
            result[pattern] = override;
        }
    }
    return result;
}

/**
 * Collapses every override whose pattern matches the id into one, in the order
 * the settings object declares them, so a later, more specific entry can refine
 * an earlier broad one field by field.
 */
export function overridesFor(
    id: string,
    overrides: Record<string, ModelOverride>
): ModelOverride {
    let merged: ModelOverride = {};
    for (const [pattern, override] of Object.entries(overrides)) {
        if (matchesPattern(id, pattern)) {
            merged = { ...merged, ...override };
        }
    }
    return merged;
}

function pick<K extends string, V>(
    key: K,
    value: V | undefined
): Partial<Record<K, V>> {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

/** The OpenAI protocol accepts 0 to 2; anything outside is a typo. */
function temperature(value: unknown): number | undefined {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 2
        ? value
        : undefined;
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
    return typeof value === 'string' &&
        (REASONING_EFFORTS as readonly string[]).includes(value)
        ? (value as ReasoningEffort)
        : undefined;
}

export async function setBaseUrl(baseUrl: string): Promise<void> {
    await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(
            'baseUrl',
            baseUrl,
            vscode.ConfigurationTarget.Global
        );
}

/**
 * Compiled patterns, reused across the model list and across discoveries. The
 * filter is applied once per model, so without this every listing recompiles
 * the same handful of expressions.
 */
const compiledPatterns = new Map<string, RegExp>();

/** Bounds the cache against a pathological filter; patterns are few in practice. */
const MAX_COMPILED_PATTERNS = 256;

/**
 * Matches a model id against a `*`-glob pattern. Nothing else in the pattern is
 * special, so ids containing `.` and `-` compare literally.
 *
 * Splitting on `*` first means each remaining chunk can be escaped wholesale,
 * which avoids needing a placeholder character to survive the escaping pass.
 */
export function matchesPattern(id: string, pattern: string): boolean {
    let expression = compiledPatterns.get(pattern);
    if (!expression) {
        const source = pattern
            .trim()
            .split('*')
            .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*');
        // No `g` flag, so the expression is stateless and safe to share.
        expression = new RegExp(`^${source}$`, 'i');
        if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) {
            compiledPatterns.clear();
        }
        compiledPatterns.set(pattern, expression);
    }
    return expression.test(id);
}

export function isIncludedByFilter(id: string, filter: string[]): boolean {
    if (filter.length === 0) {
        return true;
    }
    return filter.some((pattern) => matchesPattern(id, pattern));
}
