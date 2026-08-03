import * as vscode from 'vscode';

import {
    CONFIG_SECTION,
    DEFAULT_BASE_URL,
    getConfig,
    normalizeBaseUrl,
    setBaseUrl,
    VENDOR,
} from './config';
import { TetrateChatModelProvider } from './provider';
import { deleteApiKey, getApiKey, promptForApiKey } from './secrets';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Tetrate Agent Router', {
        log: true,
    });
    const provider = new TetrateChatModelProvider(context, log);

    context.subscriptions.push(
        log,
        provider,
        // Registration is synchronous and does not touch the network: VS Code
        // calls back into the provider when it actually needs the model list.
        vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),

        vscode.commands.registerCommand(
            'tetrate-model-provider.setApiKey',
            async () => {
                const apiKey = await promptForApiKey(context);
                if (!apiKey) {
                    return;
                }
                provider.invalidate();
                vscode.window.showInformationMessage(
                    'Agent Router API key saved.'
                );
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.clearApiKey',
            async () => {
                await deleteApiKey(context);
                provider.invalidate();
                vscode.window.showInformationMessage(
                    'Agent Router API key removed.'
                );
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.setBaseUrl',
            async () => {
                const current = getConfig().baseUrl;
                const value = await vscode.window.showInputBox({
                    title: 'Tetrate Agent Router',
                    prompt: 'Base URL of the Agent Router endpoint',
                    value: current,
                    valueSelection: [0, current.length],
                    placeHolder: DEFAULT_BASE_URL,
                    ignoreFocusOut: true,
                    validateInput: (input) =>
                        validateBaseUrl(input) ?? undefined,
                });
                if (value === undefined) {
                    return;
                }
                const normalized = normalizeBaseUrl(value);
                await setBaseUrl(normalized);
                provider.invalidate();
                vscode.window.showInformationMessage(
                    `Agent Router base URL set to ${normalized}`
                );
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.refreshModels',
            async () => {
                provider.invalidate();
                if (!(await getApiKey(context))) {
                    vscode.window.showWarningMessage(
                        'No Agent Router API key is configured yet. Run "Tetrate Agent Router: Set Agent Router API Key".'
                    );
                    return;
                }
                vscode.window.showInformationMessage(
                    'Reloading Agent Router models.'
                );
            }
        ),

        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(CONFIG_SECTION)) {
                log.info('Configuration changed; reloading model list.');
                provider.invalidate();
            }
        }),

        // Keeps a key change made in another window from leaving this one with a
        // stale model list.
        context.secrets.onDidChange(() => provider.invalidate())
    );
}

export function deactivate() {}

/** Returns an error message, or null when the input is acceptable. */
export function validateBaseUrl(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return null; // falls back to the default
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return 'Enter a full URL, for example https://api.router.tetrate.ai/v1';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return 'The URL must use http or https.';
    }
    return null;
}
