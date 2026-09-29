import { createHash } from 'node:crypto';
import {
    chmod,
    copyFile,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * Claude Code passthrough configuration: pointing the Claude Code CLI (and
 * the IDE integrations that run it) at the Agent Router gateway, with the
 * Agent Router key in the `x-tars-api-key` header so the developer's own
 * Claude subscription sign-in authenticates upstream.
 *
 * The extension only edits Claude Code's settings file. It never reads,
 * stores, or forwards the Claude sign-in itself: Anthropic requires that
 * sign-in to complete through its own flow and forbids third parties from
 * intermediating subscription credentials, so passthrough traffic has to
 * originate from Claude Code, not from this extension's model provider.
 *
 * Deliberately free of any `vscode` import, like usage.ts, so the settings
 * arithmetic stays testable against a temporary directory.
 */

/** The header the gateway reads the Agent Router key from in passthrough. */
export const TARS_KEY_HEADER = 'x-tars-api-key';

export const BASE_URL_VAR = 'ANTHROPIC_BASE_URL';
export const CUSTOM_HEADERS_VAR = 'ANTHROPIC_CUSTOM_HEADERS';
export const DISCOVERY_VAR = 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY';

/**
 * Either of these makes Claude Code authenticate with its own credential
 * instead of the subscription sign-in, which silently turns passthrough into
 * managed mode.
 */
export const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** Which models the Claude Code picker cache lists; see buildModelCache. */
export type PickerModels = 'anthropic' | 'all' | 'off';
export const PICKER_MODELS: readonly PickerModels[] = ['anthropic', 'all', 'off'];

export type Settings = Record<string, unknown>;

export type ParsedSettings =
    | { ok: true; settings: Settings }
    | { ok: false; reason: string };

/** What the extension wrote, so removal can undo exactly that and no more. */
export type RecordedIntegration = {
    configDir: string;
    host: string;
    /** SHA-256 of the key written; the key itself is never recorded. */
    keyFingerprint: string;
    discovery: boolean;
    at: number;
};

export type ClaudeCodeState =
    | 'unparseable'
    | 'not-configured'
    | 'managed'
    | 'passthrough-here'
    | 'passthrough-stale-key'
    | 'other-endpoint';

/** The picker cache format, observed in Claude Code 2.1.251; unofficial. */
export type ModelCacheFile = {
    baseUrl: string;
    fetchedAt: number;
    models: Array<{ id: string }>;
};

/** `CLAUDE_CONFIG_DIR` relocates everything Claude Code keeps in `~/.claude`. */
export function claudeConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    const override = env.CLAUDE_CONFIG_DIR?.trim();
    return override ? override : path.join(home, '.claude');
}

/**
 * Anthropic clients append `/v1/messages` to the base URL themselves, so
 * Claude Code wants the gateway host without the version segment that
 * normalizeBaseUrl guarantees. A path prefix before it is kept.
 */
export function proxyHostOf(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

export function keyFingerprint(key: string): string {
    return createHash('sha256').update(key.trim()).digest('hex');
}

export function settingsPath(configDir: string): string {
    return path.join(configDir, 'settings.json');
}

export function modelCachePath(configDir: string): string {
    return path.join(configDir, 'cache', 'gateway-models.json');
}

/**
 * A missing or empty file is an empty settings object. Anything that does not
 * parse is reported rather than replaced: the file is the user's, and
 * rewriting it from a guess would lose whatever it held.
 */
export function parseSettings(text: string | undefined): ParsedSettings {
    if (text === undefined || text.trim().length === 0) {
        return { ok: true, settings: {} };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return {
            ok: false,
            reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        };
    }
    if (!isRecord(parsed)) {
        return { ok: false, reason: 'the top level is not an object' };
    }
    if (parsed.env !== undefined && !isRecord(parsed.env)) {
        return { ok: false, reason: 'its "env" entry is not an object' };
    }
    return { ok: true, settings: parsed };
}

/** The value of one header in a newline-separated `Name: Value` list. */
export function readHeader(
    value: string | undefined,
    name: string
): string | undefined {
    for (const line of headerLines(value)) {
        if (headerName(line) === name.toLowerCase()) {
            return line.slice(line.indexOf(':') + 1).trim();
        }
    }
    return undefined;
}

/** Sets one header, keeping every other line the user put there. */
export function withHeader(
    value: string | undefined,
    name: string,
    headerValue: string
): string {
    return [
        ...headerLines(value).filter(
            (line) => headerName(line) !== name.toLowerCase()
        ),
        `${name}: ${headerValue}`,
    ].join('\n');
}

/** Removes one header; undefined when no line is left. */
export function withoutHeader(
    value: string | undefined,
    name: string
): string | undefined {
    const rest = headerLines(value).filter(
        (line) => headerName(line) !== name.toLowerCase()
    );
    return rest.length > 0 ? rest.join('\n') : undefined;
}

/**
 * Points Claude Code at the gateway in passthrough mode. Credential variables
 * in the same `env` block are removed, since either would make Claude Code
 * skip the subscription sign-in; every other setting is left as it was.
 */
export function applyPassthrough(
    settings: Settings,
    target: { host: string; key: string; discovery: boolean }
): { settings: Settings; removedCredentials: string[] } {
    const env = { ...envOf(settings) };
    const removedCredentials = CREDENTIAL_VARS.filter((name) => name in env);
    for (const name of removedCredentials) {
        delete env[name];
    }
    env[BASE_URL_VAR] = target.host;
    env[CUSTOM_HEADERS_VAR] = withHeader(
        stringOf(env[CUSTOM_HEADERS_VAR]),
        TARS_KEY_HEADER,
        target.key.trim()
    );
    if (target.discovery) {
        env[DISCOVERY_VAR] = '1';
    }
    return { settings: { ...settings, env }, removedCredentials };
}

/** Replaces only the key, for a rotation; nothing else is re-asserted. */
export function replaceKey(settings: Settings, key: string): Settings {
    const env = { ...envOf(settings) };
    env[CUSTOM_HEADERS_VAR] = withHeader(
        stringOf(env[CUSTOM_HEADERS_VAR]),
        TARS_KEY_HEADER,
        key.trim()
    );
    return { ...settings, env };
}

/**
 * Undoes applyPassthrough. A value is removed only while it still holds what
 * the extension wrote; one the user has changed since is kept and named, so
 * a hand edit is never lost to a cleanup.
 */
export function removePassthrough(
    settings: Settings,
    recorded: RecordedIntegration
): { settings: Settings; kept: string[] } {
    const env = { ...envOf(settings) };
    const kept: string[] = [];

    if (env[BASE_URL_VAR] === recorded.host) {
        delete env[BASE_URL_VAR];
    } else if (env[BASE_URL_VAR] !== undefined) {
        kept.push(BASE_URL_VAR);
    }

    const headers = stringOf(env[CUSTOM_HEADERS_VAR]);
    const key = readHeader(headers, TARS_KEY_HEADER);
    if (key !== undefined) {
        if (keyFingerprint(key) === recorded.keyFingerprint) {
            const rest = withoutHeader(headers, TARS_KEY_HEADER);
            if (rest === undefined) {
                delete env[CUSTOM_HEADERS_VAR];
            } else {
                env[CUSTOM_HEADERS_VAR] = rest;
            }
        } else {
            kept.push(CUSTOM_HEADERS_VAR);
        }
    }

    if (recorded.discovery && env[DISCOVERY_VAR] === '1') {
        delete env[DISCOVERY_VAR];
    }

    const next: Settings = { ...settings };
    if (Object.keys(env).length === 0) {
        delete next.env;
    } else {
        next.env = env;
    }
    return { settings: next, kept };
}

/** How the settings file routes Claude Code relative to this endpoint. */
export function detectState(
    parsed: ParsedSettings,
    target: { host: string; key: string | undefined }
): ClaudeCodeState {
    if (!parsed.ok) {
        return 'unparseable';
    }
    const env = envOf(parsed.settings);
    const base = nonEmpty(env[BASE_URL_VAR]);
    if (!base) {
        return 'not-configured';
    }
    if (CREDENTIAL_VARS.some((name) => nonEmpty(env[name]))) {
        return 'managed';
    }
    if (trimSlashes(base) !== trimSlashes(target.host)) {
        return 'other-endpoint';
    }
    const key = readHeader(stringOf(env[CUSTOM_HEADERS_VAR]), TARS_KEY_HEADER);
    if (!key || !target.key || key !== target.key.trim()) {
        return 'passthrough-stale-key';
    }
    return 'passthrough-here';
}

export function describeClaudeCodeState(state: ClaudeCodeState): string {
    switch (state) {
        case 'unparseable':
            return 'settings.json could not be read';
        case 'not-configured':
            return 'not configured';
        case 'managed':
            return 'uses an API key, not passthrough';
        case 'passthrough-here':
            return 'passthrough via this endpoint';
        case 'passthrough-stale-key':
            return 'passthrough, key missing or out of date';
        case 'other-endpoint':
            return 'points at another endpoint';
    }
}

/**
 * Only Anthropic providers support passthrough; any other model would route
 * on Agent Router's own credentials and bill there. Claude Code applies the
 * same id test to the lists it discovers itself.
 */
export function isAnthropicModel(model: { id: string; family?: string }): boolean {
    return model.family === 'anthropic' || /claude|anthropic/i.test(model.id);
}

export function buildModelCache(
    models: ReadonlyArray<{ id: string; family?: string }>,
    host: string,
    picker: Exclude<PickerModels, 'off'>,
    now: number
): ModelCacheFile {
    const ids = new Set<string>();
    for (const model of models) {
        if (picker === 'all' || isAnthropicModel(model)) {
            ids.add(model.id);
        }
    }
    return {
        baseUrl: host,
        fetchedAt: now,
        models: [...ids].map((id) => ({ id })),
    };
}

export async function readSettings(
    configDir: string
): Promise<{ exists: boolean; parsed: ParsedSettings }> {
    const text = await readOptional(settingsPath(configDir));
    return { exists: text !== undefined, parsed: parseSettings(text) };
}

/**
 * Writes the settings atomically with owner-only permissions, since the file
 * now carries a key. `backupAt` first copies the existing file aside; only
 * the configure step asks for it, because a backup taken after the key was
 * written would leave a stray copy of the key behind.
 */
export async function writeSettings(
    configDir: string,
    settings: Settings,
    options: { backupAt?: number } = {}
): Promise<string | undefined> {
    const target = settingsPath(configDir);
    let backup: string | undefined;
    if (options.backupAt !== undefined) {
        const stamp = new Date(options.backupAt)
            .toISOString()
            .replace(/[:.]/g, '-');
        backup = `${target}.bak-${stamp}`;
        await copyFile(target, backup);
        await chmod(backup, 0o600);
    }
    await writeFileAtomic(target, `${JSON.stringify(settings, null, 2)}\n`);
    return backup;
}

export async function writeModelCache(
    configDir: string,
    cache: ModelCacheFile
): Promise<void> {
    await writeFileAtomic(modelCachePath(configDir), JSON.stringify(cache));
}

/** The base URL a picker cache was written for, when one exists. */
export async function readModelCacheBaseUrl(
    configDir: string
): Promise<string | undefined> {
    try {
        const parsed: unknown = JSON.parse(
            (await readOptional(modelCachePath(configDir))) ?? ''
        );
        return isRecord(parsed) && typeof parsed.baseUrl === 'string'
            ? parsed.baseUrl
            : undefined;
    } catch {
        return undefined;
    }
}

export async function deleteModelCache(configDir: string): Promise<void> {
    await rm(modelCachePath(configDir), { force: true });
}

async function writeFileAtomic(target: string, text: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeFile(temp, text, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, target);
    } catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}

async function readOptional(file: string): Promise<string | undefined> {
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

function headerLines(value: string | undefined): string[] {
    return (value ?? '')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
}

function headerName(line: string): string {
    const colon = line.indexOf(':');
    return (colon < 0 ? line : line.slice(0, colon)).trim().toLowerCase();
}

function envOf(settings: Settings): Record<string, unknown> {
    return isRecord(settings.env) ? settings.env : {};
}

function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function trimSlashes(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
