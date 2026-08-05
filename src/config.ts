import * as vscode from 'vscode';

export const VENDOR = 'tetrate-agent-router';
export const CONFIG_SECTION = 'tetrate-model-provider';

/** Ships as the setting's default too, so both agree by construction. */
export const DEFAULT_BASE_URL = 'https://api.router.tetrate.ai/v1';

export type ProviderConfig = {
    baseUrl: string;
    modelFilter: string[];
    requestHeaders: Record<string, string>;
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
    };
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
