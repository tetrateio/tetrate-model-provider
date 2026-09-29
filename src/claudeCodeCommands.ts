import * as vscode from 'vscode';

import {
    applyPassthrough,
    buildModelCache,
    type ClaudeCodeState,
    CREDENTIAL_VARS,
    deleteModelCache,
    detectState,
    keyFingerprint,
    proxyHostOf,
    readModelCacheBaseUrl,
    readSettings,
    type RecordedIntegration,
    removePassthrough,
    replaceKey,
    settingsPath,
    writeModelCache,
    writeSettings,
} from './claudeCode';
import { DEFAULT_BASE_URL, getConfig } from './config';

/**
 * The Configure, Remove, and Refresh flows for Claude Code passthrough, and
 * the key-rotation follow-up. The settings arithmetic lives in claudeCode.ts;
 * this module owns the prompts and the record of what was written.
 */

export const CLAUDE_INTEGRATION_KEY = 'tetrate-model-provider.claudeCodeIntegration';

/** The subset of `vscode.Memento` this module needs; see catalogCache.ts. */
type IntegrationStore = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
};

export type ClaudeCodeDeps = {
    store: IntegrationStore;
    /** The key stored for an endpoint, as secrets.getApiKey resolves it. */
    apiKey(baseUrl: string): Promise<string | undefined>;
    /**
     * Every model the key reaches, fetched live rather than from a memo, so
     * a revoked key fails here instead of being written to Claude Code.
     */
    fetchModels(): Promise<ReadonlyArray<{ id: string; family?: string }>>;
    configDir(): string;
    log: { info(message: string): void; warn(message: string): void };
};

/** The record of what was written, read defensively like every stored shape. */
export function readRecorded(
    store: IntegrationStore
): RecordedIntegration | undefined {
    const raw = store.get<RecordedIntegration>(CLAUDE_INTEGRATION_KEY);
    if (
        !raw ||
        typeof raw.configDir !== 'string' ||
        typeof raw.host !== 'string' ||
        typeof raw.keyFingerprint !== 'string'
    ) {
        return undefined;
    }
    return { ...raw, discovery: raw.discovery === true };
}

/** The Claude Code routing state relative to the configured endpoint. */
export async function claudeCodeState(
    deps: ClaudeCodeDeps
): Promise<ClaudeCodeState> {
    const config = getConfig();
    try {
        const { parsed } = await readSettings(deps.configDir());
        return detectState(parsed, {
            host: proxyHostOf(config.baseUrl),
            key: await deps.apiKey(config.baseUrl),
        });
    } catch {
        return 'unparseable';
    }
}

export async function configureClaudeCodeFlow(
    deps: ClaudeCodeDeps
): Promise<boolean> {
    const config = getConfig();
    const key = await deps.apiKey(config.baseUrl);
    if (!key) {
        void vscode.window.showWarningMessage(
            'No Agent Router API key is configured yet. Run "Tetrate Agent Router: Set Agent Router API Key".'
        );
        return false;
    }

    const configDir = deps.configDir();
    const host = proxyHostOf(config.baseUrl);
    if (!(await readableSettings(configDir))) {
        return false;
    }

    const remote = vscode.env.remoteName;
    const notes = [
        'Claude Code reads custom headers only from its settings, so the Agent Router key is copied into that file in plain text, readable only by your user account. "Remove Claude Code Configuration" takes it out again.',
        'Claude Code keeps signing in with your own Claude subscription through Anthropic’s sign-in; this extension never reads or forwards that sign-in. Only Anthropic models pass through; other models route on Agent Router’s credentials.',
        'Models chosen in VS Code chat or by other extensions are unaffected and stay billed to Agent Router.',
        ...(config.baseUrl === DEFAULT_BASE_URL
            ? [
                  'Passthrough is an Agent Router Enterprise feature, which the hosted endpoint may not offer.',
              ]
            : []),
        ...(remote
            ? [
                  `This window is remote (${remote}). The Claude Code settings on this local machine are changed, not the remote ones.`,
              ]
            : []),
    ];
    const confirm = 'Configure';
    const choice = await vscode.window.showWarningMessage(
        `Route Claude Code through ${host} in passthrough mode?`,
        {
            modal: true,
            detail: `Writes ${settingsPath(configDir)}.\n\n${notes.join('\n\n')}`,
        },
        confirm
    );
    if (choice !== confirm) {
        return false;
    }

    let models: ReadonlyArray<{ id: string; family?: string }>;
    try {
        models = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Checking the Agent Router key…',
            },
            () => deps.fetchModels()
        );
    } catch (error) {
        void vscode.window.showErrorMessage(
            `The Agent Router key was not accepted at ${config.baseUrl}, so Claude Code was left unchanged. ${message(error)}`
        );
        return false;
    }

    // Re-read after the prompt: the file may have changed while it was open.
    const current = await readSettings(configDir);
    if (!current.parsed.ok) {
        reportUnreadable(configDir, current.parsed.reason);
        return false;
    }
    const picker = config.claudeCodePickerModels;
    const discovery = picker !== 'off';
    const { settings, removedCredentials } = applyPassthrough(
        current.parsed.settings,
        { host, key, discovery }
    );
    // Back up only the user's own file, never one this extension already
    // wrote a key into.
    const now = Date.now();
    const backup = await writeSettings(
        configDir,
        settings,
        current.exists && !readRecorded(deps.store) ? { backupAt: now } : {}
    );
    if (picker !== 'off') {
        await writeModelCache(
            configDir,
            buildModelCache(models, host, picker, now)
        );
    }
    await deps.store.update(CLAUDE_INTEGRATION_KEY, {
        configDir,
        host,
        keyFingerprint: keyFingerprint(key),
        discovery,
        at: now,
    } satisfies RecordedIntegration);

    deps.log.info(
        `Configured Claude Code passthrough via ${host} in ${settingsPath(configDir)}${backup ? `; previous file saved as ${backup}` : ''}.`
    );
    const removed =
        removedCredentials.length > 0
            ? ` ${removedCredentials.join(' and ')} was removed from its settings, since it would override the subscription sign-in.`
            : '';
    const shellNote = ` If ${CREDENTIAL_VARS[0]} is exported in your shell, unset it.`;
    const signIn = 'Sign In to Claude';
    const open = 'Open settings.json';
    const action = await vscode.window.showInformationMessage(
        `Claude Code now routes through ${host} in passthrough mode. Sign in with your Claude subscription if you have not already.${removed}${shellNote}`,
        signIn,
        open
    );
    if (action === signIn) {
        // Anthropic's own sign-in flow, run in a terminal the user watches.
        const terminal = vscode.window.createTerminal({ name: 'Claude sign-in' });
        terminal.show();
        terminal.sendText('claude /login');
    } else if (action === open) {
        await openSettings(configDir);
    }
    return true;
}

export async function removeClaudeCodeFlow(
    deps: ClaudeCodeDeps
): Promise<boolean> {
    const recorded = readRecorded(deps.store);
    if (!recorded) {
        void vscode.window.showInformationMessage(
            'Claude Code was not configured by this extension, so nothing was changed.'
        );
        return false;
    }
    const current = await readSettings(recorded.configDir);
    if (!current.parsed.ok) {
        reportUnreadable(recorded.configDir, current.parsed.reason);
        return false;
    }

    let kept: string[] = [];
    if (current.exists) {
        const result = removePassthrough(current.parsed.settings, recorded);
        kept = result.kept;
        await writeSettings(recorded.configDir, result.settings);
    }
    if (
        recorded.discovery &&
        (await readModelCacheBaseUrl(recorded.configDir)) === recorded.host
    ) {
        await deleteModelCache(recorded.configDir);
    }
    await deps.store.update(CLAUDE_INTEGRATION_KEY, undefined);

    deps.log.info(
        `Removed the Claude Code passthrough configuration from ${settingsPath(recorded.configDir)}.`
    );
    void vscode.window.showInformationMessage(
        kept.length > 0
            ? `Removed the Claude Code passthrough configuration. ${kept.join(' and ')} had been changed by hand and ${kept.length === 1 ? 'was' : 'were'} left in place.`
            : 'Removed the Claude Code passthrough configuration.'
    );
    return true;
}

/**
 * Rewrites the picker cache from the current model list. Quiet mode is for
 * background refreshes, which only act when there is something to update.
 */
export async function refreshClaudeCodeModels(
    deps: ClaudeCodeDeps,
    options: { quiet?: boolean } = {}
): Promise<void> {
    const say = (text: string) => {
        if (!options.quiet) {
            void vscode.window.showInformationMessage(text);
        }
    };
    const recorded = readRecorded(deps.store);
    const config = getConfig();
    const picker = config.claudeCodePickerModels;
    if (!recorded || picker === 'off') {
        say(
            'Claude Code is not configured for passthrough with a model picker. Run "Configure Claude Code for Passthrough" first.'
        );
        return;
    }
    if (proxyHostOf(config.baseUrl) !== recorded.host) {
        say(
            `Claude Code is configured for ${recorded.host}, not the current endpoint, so its model picker was left alone.`
        );
        return;
    }

    let models: ReadonlyArray<{ id: string; family?: string }>;
    try {
        models = await deps.fetchModels();
    } catch (error) {
        deps.log.warn(
            `Could not refresh the Claude Code model picker: ${message(error)}`
        );
        if (!options.quiet) {
            void vscode.window.showErrorMessage(
                `Could not refresh the Claude Code model picker. ${message(error)}`
            );
        }
        return;
    }
    const cache = buildModelCache(models, recorded.host, picker, Date.now());
    await writeModelCache(recorded.configDir, cache);
    if (!recorded.discovery) {
        // The picker was switched on after configuring; discovery has to be
        // enabled for Claude Code to read the cache at all.
        const current = await readSettings(recorded.configDir);
        if (current.exists && current.parsed.ok) {
            const env = current.parsed.settings.env as
                | Record<string, unknown>
                | undefined;
            await writeSettings(recorded.configDir, {
                ...current.parsed.settings,
                env: { ...env, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
            });
            await deps.store.update(CLAUDE_INTEGRATION_KEY, {
                ...recorded,
                discovery: true,
            } satisfies RecordedIntegration);
        }
    }
    deps.log.info(
        `Claude Code model picker cache lists ${cache.models.length} model(s).`
    );
    say(
        `Claude Code's model picker now lists ${cache.models.length} model(s). Open /model in Claude Code to see them.`
    );
}

/** Collapses the several secret-change events one key edit fires. */
let syncing: Promise<void> | undefined;

/**
 * Follows a key change on the recorded endpoint: a new key is offered to
 * Claude Code, and a cleared one prompts removing the stale copy, since a
 * revoked key left in a file is exactly what "clear" should not leave.
 */
export function syncClaudeCodeKey(deps: ClaudeCodeDeps): Promise<void> {
    syncing ??= (async () => {
        try {
            await syncOnce(deps);
        } finally {
            syncing = undefined;
        }
    })();
    return syncing;
}

async function syncOnce(deps: ClaudeCodeDeps): Promise<void> {
    const recorded = readRecorded(deps.store);
    const config = getConfig();
    if (!recorded || proxyHostOf(config.baseUrl) !== recorded.host) {
        return;
    }
    const key = await deps.apiKey(config.baseUrl);
    if (key && keyFingerprint(key) === recorded.keyFingerprint) {
        return;
    }

    if (!key) {
        const remove = 'Remove from Claude Code';
        const action = await vscode.window.showWarningMessage(
            'The Agent Router key was removed, but Claude Code still holds a copy of it in its settings.',
            remove
        );
        if (action === remove) {
            await removeClaudeCodeFlow(deps);
        }
        return;
    }

    const update = 'Update Claude Code';
    const action = await vscode.window.showInformationMessage(
        'The Agent Router key changed. Update the copy Claude Code uses for passthrough?',
        update
    );
    if (action !== update) {
        return;
    }
    const current = await readSettings(recorded.configDir);
    if (!current.parsed.ok) {
        reportUnreadable(recorded.configDir, current.parsed.reason);
        return;
    }
    // Only a configuration that still points here gets the new key; one the
    // user has since pointed elsewhere or switched to managed is theirs.
    const state = detectState(current.parsed, { host: recorded.host, key });
    if (state !== 'passthrough-stale-key') {
        void vscode.window.showInformationMessage(
            'Claude Code no longer routes through this endpoint in passthrough mode, so its settings were left unchanged.'
        );
        return;
    }
    await writeSettings(
        recorded.configDir,
        replaceKey(current.parsed.settings, key)
    );
    await deps.store.update(CLAUDE_INTEGRATION_KEY, {
        ...recorded,
        keyFingerprint: keyFingerprint(key),
        at: Date.now(),
    } satisfies RecordedIntegration);
    deps.log.info('Updated the Agent Router key in the Claude Code settings.');
}

/** Checks the settings parse before prompting; reports and fails otherwise. */
async function readableSettings(configDir: string): Promise<boolean> {
    try {
        const { parsed } = await readSettings(configDir);
        if (!parsed.ok) {
            reportUnreadable(configDir, parsed.reason);
            return false;
        }
        return true;
    } catch (error) {
        reportUnreadable(configDir, message(error));
        return false;
    }
}

function reportUnreadable(configDir: string, reason: string): void {
    const open = 'Open settings.json';
    void vscode.window
        .showErrorMessage(
            `The Claude Code settings at ${settingsPath(configDir)} could not be read: ${reason}. Nothing was changed.`,
            open
        )
        .then((action) =>
            action === open ? openSettings(configDir) : undefined
        );
}

async function openSettings(configDir: string): Promise<void> {
    await vscode.window.showTextDocument(
        vscode.Uri.file(settingsPath(configDir))
    );
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
