import * as vscode from 'vscode';

import { fetchApiModels, selectChatModels } from './catalog';
import {
    clearPublicCatalogCache,
    loadPublicCatalog,
    peekPublicCatalog,
} from './catalogCache';
import {
    CONFIG_SECTION,
    DEFAULT_BASE_URL,
    getConfig,
    normalizeBaseUrl,
    setBaseUrl,
    VENDOR,
} from './config';
import { buildStatusReport } from './diagnostics';
import { TetrateChatModelProvider } from './provider';
import {
    API_KEY_SECRET,
    deleteApiKey,
    getApiKey,
    promptForApiKey,
} from './secrets';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Tetrate Agent Router', {
        log: true,
    });
    const provider = new TetrateChatModelProvider(context, log);

    // Appears after the first completed request and shows the session cost, or
    // the token count when no price is known. Clicking it opens the breakdown.
    const usageBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    usageBar.name = 'Agent Router usage';
    usageBar.command = 'tetrate-model-provider.showUsage';
    usageBar.tooltip =
        'Agent Router usage this session. Click for the per-model breakdown.';

    context.subscriptions.push(
        log,
        provider,
        usageBar,
        provider.usage.subscribe(() => {
            usageBar.text = `$(pulse) ${provider.usage.headline()}`;
            usageBar.show();
        }),
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
                // An explicit refresh should outrank the catalog's day-long
                // TTL, otherwise new metadata stays invisible until it lapses.
                await clearPublicCatalogCache(context.globalState);
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

        vscode.commands.registerCommand(
            'tetrate-model-provider.showUsage',
            async () => {
                if (provider.usage.requestCount === 0) {
                    vscode.window.showInformationMessage(
                        'No Agent Router requests have been made this session.'
                    );
                    return;
                }
                const lines = provider.usage.summarize();
                for (const line of lines) {
                    log.info(line);
                }
                const openLog = 'Open Log';
                const action = await vscode.window.showInformationMessage(
                    `Agent Router: ${lines[lines.length - 1]}`,
                    openLog
                );
                if (action === openLog) {
                    log.show();
                }
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.showStatus',
            async () => {
                const config = getConfig();
                const key = await getApiKey(context);
                const cached = peekPublicCatalog(context.globalState);

                const report = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Checking the Agent Router connection…',
                    },
                    () =>
                        buildStatusReport({
                            version: String(
                                context.extension.packageJSON.version
                            ),
                            config,
                            keyStored: Boolean(key),
                            probeModels: key
                                ? async () => {
                                      const [apiModels, catalog] =
                                          await Promise.all([
                                              fetchApiModels(
                                                  config.baseUrl,
                                                  key,
                                                  config.requestHeaders
                                              ),
                                              loadPublicCatalog(
                                                  context.globalState
                                              ),
                                          ]);
                                      return {
                                          reachable: apiModels.length,
                                          offered: selectChatModels(
                                              apiModels,
                                              catalog,
                                              config
                                          ).length,
                                      };
                                  }
                                : undefined,
                            catalog: cached
                                ? {
                                      fetchedAt: cached.fetchedAt,
                                      entries: cached.models.length,
                                  }
                                : undefined,
                        })
                );

                log.info('--- Connection status ---');
                for (const line of report.lines) {
                    log.info(line);
                }

                const openLog = 'Open Log';
                const show = report.healthy
                    ? vscode.window.showInformationMessage(
                          report.summary,
                          openLog
                      )
                    : vscode.window.showWarningMessage(report.summary, openLog);
                if ((await show) === openLog) {
                    log.show();
                }
            }
        ),

        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(CONFIG_SECTION)) {
                log.info('Configuration changed; reloading model list.');
                provider.invalidate();
            }
        }),

        // Keeps a key change made in another window from leaving this one with a
        // stale model list. The event covers every secret this extension owns,
        // so filter rather than re-querying for an unrelated key.
        context.secrets.onDidChange((event) => {
            if (event.key === API_KEY_SECRET) {
                provider.invalidate();
            }
        })
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
