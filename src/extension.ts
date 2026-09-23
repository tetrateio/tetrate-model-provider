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
    isIncludedByFilter,
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
import { formatCost } from './usage';
import { UsageHistory } from './usageHistory';

/** Where API keys are created and billing lives. */
export const DASHBOARD_URL = 'https://router.tetrate.ai/';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Tetrate Agent Router', {
        log: true,
    });
    const provider = new TetrateChatModelProvider(context, log);
    const history = new UsageHistory(context.globalState);

    // Appears after the first completed request and shows the session cost, or
    // the token count when no price is known. Clicking it opens the breakdown.
    const usageBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    usageBar.name = 'Agent Router usage';
    usageBar.command = 'tetrate-model-provider.showUsage';
    usageBar.tooltip =
        'Agent Router usage this session. Click for the breakdown.';

    // At most one warning per window: the point is to interrupt a runaway
    // agent session once, not to nag every request after the threshold.
    let spendWarned = false;
    const warnOnSpend = async () => {
        const threshold = getConfig().spendWarning;
        if (spendWarned || threshold <= 0) {
            return;
        }
        const today = history.today();
        if (today.cost < threshold) {
            return;
        }
        spendWarned = true;
        const showUsage = 'Show Usage';
        const action = await vscode.window.showWarningMessage(
            `Agent Router usage today has reached ${formatCost(today.cost)}, past the configured ${formatCost(threshold)} warning threshold.`,
            showUsage
        );
        if (action === showUsage) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.showUsage'
            );
        }
    };

    context.subscriptions.push(
        log,
        provider,
        usageBar,
        provider.usage.subscribe((event) => {
            usageBar.text = `$(pulse) ${provider.usage.headline()}`;
            usageBar.show();
            void history
                .record(event.modelId, event.usage, event.cost)
                .then(warnOnSpend);
        }),
        // Registration is synchronous and does not touch the network: VS Code
        // calls back into the provider when it actually needs the model list.
        vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),

        vscode.commands.registerCommand(
            'tetrate-model-provider.setApiKey',
            async () => {
                const apiKey = await promptForApiKey(
                    context,
                    getConfig().baseUrl
                );
                if (!apiKey) {
                    return;
                }
                provider.invalidate();
                vscode.window.showInformationMessage(
                    'Agent Router API key saved for the configured endpoint.'
                );
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.clearApiKey',
            async () => {
                await deleteApiKey(context, getConfig().baseUrl);
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
                await announceEndpoint(context, normalized);
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.switchEndpoint',
            async () => {
                const config = getConfig();
                type Item = vscode.QuickPickItem & { url: string };
                const items: Item[] = Object.entries(config.profiles).map(
                    ([name, url]) => ({
                        label: name,
                        description:
                            url === config.baseUrl ? `${url} (current)` : url,
                        url,
                    })
                );
                if (
                    !Object.values(config.profiles).includes(DEFAULT_BASE_URL)
                ) {
                    items.push({
                        label: 'Hosted service',
                        description:
                            DEFAULT_BASE_URL === config.baseUrl
                                ? `${DEFAULT_BASE_URL} (current)`
                                : DEFAULT_BASE_URL,
                        url: DEFAULT_BASE_URL,
                    });
                }
                const picked = await vscode.window.showQuickPick(items, {
                    title: 'Tetrate Agent Router',
                    placeHolder:
                        'Endpoint to use. Profiles are defined in the "profiles" setting.',
                });
                if (!picked || picked.url === config.baseUrl) {
                    return;
                }
                await setBaseUrl(picked.url);
                provider.invalidate();
                await announceEndpoint(context, picked.url);
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.chooseModels',
            async () => {
                const config = getConfig();
                const key = await getApiKey(context, config.baseUrl);
                if (!key) {
                    vscode.window.showWarningMessage(
                        'No Agent Router API key is configured yet. Run "Tetrate Agent Router: Set Agent Router API Key".'
                    );
                    return;
                }

                let all: readonly vscode.LanguageModelChatInformation[];
                try {
                    all = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: 'Loading Agent Router models…',
                        },
                        async () => {
                            const [apiModels, catalog] = await Promise.all([
                                fetchApiModels(
                                    config.baseUrl,
                                    key,
                                    config.requestHeaders
                                ),
                                loadPublicCatalog(context.globalState),
                            ]);
                            // The filter is what this command edits, so the
                            // pick list must show every model, not the
                            // currently filtered view.
                            return selectChatModels(apiModels, catalog, {
                                ...config,
                                modelFilter: [],
                            });
                        }
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Tetrate Agent Router: could not list models. ${error instanceof Error ? error.message : String(error)}`
                    );
                    return;
                }

                type Item = vscode.QuickPickItem & { id: string };
                const items: Item[] = all.map((model) => ({
                    label: model.name,
                    description: model.id,
                    detail: model.detail,
                    picked: isIncludedByFilter(model.id, config.modelFilter),
                    id: model.id,
                }));
                const selected = await vscode.window.showQuickPick(items, {
                    title: 'Tetrate Agent Router: models to offer',
                    placeHolder:
                        'The selection replaces the modelFilter setting; selecting everything clears it.',
                    canPickMany: true,
                    matchOnDescription: true,
                });
                if (selected === undefined) {
                    return;
                }

                const filter = filterFromSelection(
                    all.length,
                    selected.map((item) => item.id)
                );
                if (filter === undefined) {
                    vscode.window.showWarningMessage(
                        'Nothing was selected, so the model filter was left unchanged.'
                    );
                    return;
                }
                await vscode.workspace
                    .getConfiguration(CONFIG_SECTION)
                    .update(
                        'modelFilter',
                        filter,
                        vscode.ConfigurationTarget.Global
                    );
                provider.invalidate();
                vscode.window.showInformationMessage(
                    filter.length === 0
                        ? `Offering all ${all.length} models; the model filter was cleared.`
                        : `Offering ${filter.length} of ${all.length} models.`
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
                if (!(await getApiKey(context, getConfig().baseUrl))) {
                    const setKey = 'Set API Key';
                    const dashboard = 'Open Dashboard';
                    const action = await vscode.window.showWarningMessage(
                        'No Agent Router API key is configured yet. Keys are created in the Agent Router dashboard.',
                        setKey,
                        dashboard
                    );
                    if (action === setKey) {
                        await vscode.commands.executeCommand(
                            'tetrate-model-provider.setApiKey'
                        );
                    } else if (action === dashboard) {
                        await vscode.env.openExternal(
                            vscode.Uri.parse(DASHBOARD_URL)
                        );
                    }
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
                const today = history.today();
                const week = history.window(7);
                if (provider.usage.requestCount === 0 && today.requests === 0) {
                    vscode.window.showInformationMessage(
                        'No Agent Router requests have been made today.'
                    );
                    return;
                }
                const lines = [
                    ...(provider.usage.requestCount > 0
                        ? provider.usage.summarize()
                        : ['No requests this session.']),
                    `Today: ${today.requests} request(s), ${formatCost(today.cost)}`,
                    `Last 7 days: ${week.requests} request(s), ${formatCost(week.cost)}`,
                ];
                for (const line of lines) {
                    log.info(line);
                }
                const openLog = 'Open Log';
                const action = await vscode.window.showInformationMessage(
                    `Agent Router: ${formatCost(today.cost)} today, ${provider.usage.headline()} this session.`,
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
                const key = await getApiKey(context, config.baseUrl);
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
        // stale model list. The event covers every secret this extension owns;
        // the prefix matches the per-host names and the legacy unscoped one.
        context.secrets.onDidChange((event) => {
            if (event.key.startsWith(API_KEY_SECRET)) {
                provider.invalidate();
            }
        })
    );
}

export function deactivate() {}

/**
 * Confirms the new endpoint. Keys are stored per host, so a freshly
 * configured endpoint usually has none yet; saying so beats a later failed
 * model listing.
 */
async function announceEndpoint(
    context: vscode.ExtensionContext,
    baseUrl: string
): Promise<void> {
    if (await getApiKey(context, baseUrl)) {
        vscode.window.showInformationMessage(
            `Agent Router base URL set to ${baseUrl}`
        );
    } else {
        vscode.window.showInformationMessage(
            `Agent Router base URL set to ${baseUrl}. No API key is stored for this endpoint yet; run "Set Agent Router API Key".`
        );
    }
}

/**
 * Turns a Choose Models selection into a `modelFilter` value: everything
 * selected clears the filter, since an empty filter offers every model and
 * keeps offering new ones; nothing selected is treated as a mistake rather
 * than written, since an empty filter would mean the opposite of "none".
 */
export function filterFromSelection(
    total: number,
    selectedIds: string[]
): string[] | undefined {
    if (selectedIds.length === 0) {
        return undefined;
    }
    return selectedIds.length >= total ? [] : selectedIds;
}

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
