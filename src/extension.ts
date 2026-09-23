import * as vscode from 'vscode';

import { fetchApiModels, pricingOf, selectChatModels } from './catalog';
import {
    clearPublicCatalogCache,
    loadPublicCatalog,
    peekPublicCatalog,
} from './catalogCache';
import { registerTetrateParticipant } from './chatParticipant';
import { showCommandCenter } from './commandCenter';
import {
    CONFIG_SECTION,
    DEFAULT_BASE_URL,
    getConfig,
    normalizeBaseUrl,
    setBaseUrl,
    VENDOR,
} from './config';
import { buildStatusReport } from './diagnostics';
import {
    fetchGatewayStatus,
    fetchProviderReport,
    type GatewayStatus,
    type ProviderReport,
} from './health';
import { pickModels } from './modelPicker';
import { probeCompletion } from './onboarding';
import {
    addProfileFlow,
    profileNameOf,
    removeProfileFlow,
} from './profileCommands';
import { TetrateChatModelProvider } from './provider';
import { RequestLog } from './requestLog';
import { REQUESTS_VIEW_ID, RequestsTreeProvider } from './requestsView';
import {
    API_KEY_SECRET,
    deleteApiKey,
    getApiKey,
    promptForApiKey,
} from './secrets';
import { AgentRouterTreeProvider, type TreeNode } from './treeView';
import { formatCost } from './usage';
import { UsageHistory } from './usageHistory';
import {
    buildUsageTooltip,
    spendBackground,
    spendLevel,
    UsageDashboard,
} from './usageView';

/** Where API keys are created and billing lives. */
export const DASHBOARD_URL = 'https://router.tetrate.ai/';

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Tetrate Agent Router', {
        log: true,
    });
    const provider = new TetrateChatModelProvider(context, log);
    const history = new UsageHistory(context.globalState);
    const requestLog = new RequestLog(context.globalState);

    const dashboard = new UsageDashboard(history, provider.usage, requestLog);

    // Appears after the first completed request and shows the session cost, or
    // the token count when no price is known, and a spinner while a request
    // streams. The hover carries the per-model table and the durable daily
    // figures; clicking opens the command menu.
    const usageBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    usageBar.name = 'Agent Router usage';
    usageBar.command = 'tetrate-model-provider.menu';
    usageBar.tooltip =
        'Agent Router usage this session. Click for the menu.';

    const updateUsageBar = () => {
        // Hidden until the first completed request of the session, as before.
        if (provider.usage.requestCount === 0) {
            usageBar.hide();
            return;
        }
        const threshold = getConfig().spendWarning;
        const today = history.today();
        usageBar.text = `$(pulse) ${provider.usage.headline()}`;
        usageBar.tooltip = buildUsageTooltip({
            session: provider.usage,
            today,
            week: history.window(7),
            spendWarning: threshold,
        });
        // Warning colour at 80% of the daily threshold, error past it, so the
        // pressure is continuously visible instead of one toast.
        usageBar.backgroundColor = spendBackground(
            spendLevel(today.cost, threshold)
        );
        usageBar.show();
    };

    // While requests stream, the bar shows the oldest one's model and elapsed
    // time. A one-second timer keeps the elapsed figure moving; it only runs
    // while something is active, so an idle window costs nothing.
    let activityTimer: ReturnType<typeof setInterval> | undefined;
    const renderActivity = () => {
        const active = provider.activity.active;
        if (active.length === 0) {
            if (activityTimer) {
                clearInterval(activityTimer);
                activityTimer = undefined;
            }
            updateUsageBar();
            return;
        }
        const oldest = active[0]!;
        const seconds = Math.round((Date.now() - oldest.startedAt) / 1000);
        const others = active.length > 1 ? ` (+${active.length - 1})` : '';
        usageBar.text = `$(loading~spin) ${oldest.modelId} · ${seconds}s${others}`;
        usageBar.backgroundColor = undefined;
        usageBar.show();
        if (!activityTimer) {
            activityTimer = setInterval(renderActivity, 1000);
        }
    };

    // At most one warning per window: the point is to interrupt a runaway
    // agent session once, not to nag every request after the threshold.
    let spendWarned = false;
    let fallbackStreak = 0;
    let fallbackHinted = false;
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

    // The tree curates the filter, so it needs every reachable model, not the
    // filtered view the provider caches. Memoized on the provider's cadence;
    // invalidation drops it alongside the provider's own cache.
    let allModelsCache:
        | {
              at: number;
              models: readonly vscode.LanguageModelChatInformation[];
          }
        | undefined;
    const listAllModels = async (): Promise<
        readonly vscode.LanguageModelChatInformation[]
    > => {
        const config = getConfig();
        const key = await getApiKey(context, config.baseUrl);
        if (!key) {
            return [];
        }
        if (allModelsCache && Date.now() - allModelsCache.at < 15 * 60_000) {
            return allModelsCache.models;
        }
        const [apiModels, catalog] = await Promise.all([
            fetchApiModels(config.baseUrl, key, config.requestHeaders),
            loadPublicCatalog(context.globalState),
        ]);
        const models = selectChatModels(apiModels, catalog, {
            ...config,
            modelFilter: [],
        });
        allModelsCache = { at: Date.now(), models };
        return models;
    };

    // Health lookups are memoized briefly: the tree re-renders on every
    // usage event, and hammering the status endpoints on each would turn a
    // health display into load.
    const HEALTH_MEMO_MS = 30_000;
    let gatewayMemo:
        | { key: string; at: number; value: Promise<GatewayStatus> }
        | undefined;
    const gatewayStatus = () => {
        const key = getConfig().baseUrl;
        if (
            !gatewayMemo ||
            gatewayMemo.key !== key ||
            Date.now() - gatewayMemo.at > HEALTH_MEMO_MS
        ) {
            gatewayMemo = { key, at: Date.now(), value: fetchGatewayStatus(key) };
        }
        return gatewayMemo.value;
    };
    let providerMemo:
        | { key: string; at: number; value: Promise<ProviderReport | undefined> }
        | undefined;
    const providerReport = () => {
        const key = getConfig().baseUrl;
        if (
            !providerMemo ||
            providerMemo.key !== key ||
            Date.now() - providerMemo.at > HEALTH_MEMO_MS
        ) {
            providerMemo = {
                key,
                at: Date.now(),
                value: (async () => {
                    const config = getConfig();
                    const apiKey = await getApiKey(context, config.baseUrl);
                    if (!apiKey) {
                        return undefined;
                    }
                    return fetchProviderReport(
                        config.baseUrl,
                        apiKey,
                        config.requestHeaders
                    );
                })(),
            };
        }
        return providerMemo.value;
    };

    const tree = new AgentRouterTreeProvider({
        hasKey: async (baseUrl) =>
            Boolean(await getApiKey(context, baseUrl)),
        listAllModels,
        gatewayStatus,
        providerReport,
        catalogInfo: () => {
            const cached = peekPublicCatalog(context.globalState);
            return cached
                ? { fetchedAt: cached.fetchedAt, entries: cached.models.length }
                : undefined;
        },
        latencyOf: (modelId) => provider.usage.firstOutputStats(modelId),
        session: provider.usage,
        history,
    });
    const treeView = vscode.window.createTreeView(
        'tetrate-model-provider.overview',
        { treeDataProvider: tree }
    );
    const requestsView = new RequestsTreeProvider(requestLog);

    context.subscriptions.push(
        log,
        provider,
        usageBar,
        dashboard,
        tree,
        treeView,
        requestsView,
        vscode.window.registerTreeDataProvider(REQUESTS_VIEW_ID, requestsView),
        registerTetrateParticipant({
            usageLines: () => provider.usage.summarize(),
            today: () => history.today(),
            week: () => history.window(7),
            listModels: listAllModels,
            priceOf: (modelId) => {
                const models =
                    peekPublicCatalog(context.globalState)?.models ?? [];
                return pricingOf(
                    models.find(
                        (model) =>
                            model.model.toLowerCase() === modelId.toLowerCase()
                    )
                );
            },
            profiles: () => getConfig().profiles,
            currentBaseUrl: () => getConfig().baseUrl,
            switchTo: async (url) => {
                await setBaseUrl(url);
                provider.invalidate();
            },
        }),
        { dispose: () => clearInterval(activityTimer) },
        provider.activity.subscribe(renderActivity),
        treeView.onDidChangeCheckboxState(async (event) => {
            const changes = event.items.map(
                ([node, state]) =>
                    [
                        node,
                        state === vscode.TreeItemCheckboxState.Checked,
                    ] as [TreeNode, boolean]
            );
            const outcome = await tree.applyCheckboxChanges(changes);
            if (outcome === 'rejected-empty') {
                vscode.window.showWarningMessage(
                    'At least one model must stay included; the filter was left unchanged.'
                );
                tree.refresh();
                return;
            }
            provider.invalidate();
        }),
        // A key or settings change reshapes the model list, so the tree
        // follows the same invalidation the picker does.
        provider.onDidChangeLanguageModelChatInformation(() => {
            allModelsCache = undefined;
            tree.refresh();
        }),
        provider.usage.subscribe((event) => {
            // A run of fallback-served requests means the primary is likely
            // degraded; one hint per window, reset by any direct answer.
            if (event.meta?.servedBy) {
                fallbackStreak += 1;
                if (fallbackStreak >= 3 && !fallbackHinted) {
                    fallbackHinted = true;
                    vscode.window.showInformationMessage(
                        'Recent Agent Router requests are being served by fallback backends; the primary model may be degraded. The Recent Requests view names the backends.'
                    );
                }
            } else {
                fallbackStreak = 0;
            }
            requestLog.add({
                at: Date.now(),
                modelId: event.modelId,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                ...(event.cost !== undefined ? { cost: event.cost } : {}),
                durationMs: event.meta?.durationMs ?? 0,
                ...(event.meta?.firstOutputMs !== undefined
                    ? { firstOutputMs: event.meta.firstOutputMs }
                    : {}),
                ...(event.meta?.finishReason
                    ? { finishReason: event.meta.finishReason }
                    : {}),
                ...(event.meta?.requestId
                    ? { requestId: event.meta.requestId }
                    : {}),
                ...(event.meta?.servedBy
                    ? { servedBy: event.meta.servedBy }
                    : {}),
            });
            void history
                .record(event.modelId, event.usage, event.cost)
                .then(() => {
                    updateUsageBar();
                    dashboard.update();
                    tree.refresh();
                    const today = history.today();
                    treeView.badge = {
                        value: today.requests,
                        tooltip: `${formatCost(today.cost)} today`,
                    };
                    return warnOnSpend();
                });
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
                // The natural next steps after a fresh key: curate the list,
                // then prove the setup with a real round trip.
                const chooseModels = 'Choose Models';
                const test = 'Test Connection';
                const action = await vscode.window.showInformationMessage(
                    'Agent Router API key saved for the configured endpoint.',
                    chooseModels,
                    test
                );
                if (action === chooseModels) {
                    await vscode.commands.executeCommand(
                        'tetrate-model-provider.chooseModels'
                    );
                } else if (action === test) {
                    await vscode.commands.executeCommand(
                        'tetrate-model-provider.testConnection'
                    );
                }
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
            async (node?: unknown) => {
                const config = getConfig();
                // A profile row in the tree passes itself as the argument, so
                // clicking it switches directly instead of re-asking.
                const clicked = profileNameOf(node);
                if (clicked) {
                    const url = config.profiles[clicked];
                    if (url && url !== config.baseUrl) {
                        await setBaseUrl(url);
                        provider.invalidate();
                        await announceEndpoint(context, url);
                    }
                    return;
                }
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

                const report = await providerReport();
                const failing = new Set(
                    (report?.providers ?? [])
                        .filter((provider) => provider.reachable === false)
                        .map((provider) => provider.name.toLowerCase())
                );
                const selected = await pickModels(
                    all,
                    config.modelFilter,
                    failing
                );
                if (selected === undefined) {
                    return;
                }

                const filter = filterFromSelection(all.length, selected);
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

        vscode.commands.registerCommand('tetrate-model-provider.menu', () => {
            const config = getConfig();
            const profileName = Object.entries(config.profiles).find(
                ([, url]) => url === config.baseUrl
            )?.[0];
            return showCommandCenter({
                baseUrl: config.baseUrl,
                ...(profileName ? { profileName } : {}),
                sessionHeadline: provider.usage.headline(),
                todayCost: formatCost(history.today().cost),
            });
        }),

        vscode.commands.registerCommand(
            'tetrate-model-provider.openDashboard',
            () => {
                dashboard.show();
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.refreshModelsView',
            () =>
                vscode.commands.executeCommand(
                    'tetrate-model-provider.refreshModels'
                )
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.addProfile',
            async () => {
                await addProfileFlow();
                tree.refresh();
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.removeProfile',
            async (node?: unknown) => {
                await removeProfileFlow(profileNameOf(node));
                tree.refresh();
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.copyRequestId',
            async (record?: { requestId?: string }) => {
                if (!record?.requestId) {
                    return;
                }
                await vscode.env.clipboard.writeText(record.requestId);
                vscode.window.showInformationMessage(
                    'Request id copied. The Console’s Request Logs are searchable by it.'
                );
            }
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.useInChat',
            // The chat view owns model selection; opening it is as far as an
            // extension can take the user without proposed API.
            () => vscode.commands.executeCommand('workbench.action.chat.open')
        ),

        vscode.commands.registerCommand(
            'tetrate-model-provider.testConnection',
            async () => {
                const config = getConfig();
                const apiKey = await getApiKey(context, config.baseUrl);
                if (!apiKey) {
                    vscode.window.showWarningMessage(
                        'No Agent Router API key is configured yet. Run "Tetrate Agent Router: Set Agent Router API Key".'
                    );
                    return;
                }
                const result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Testing the Agent Router connection…',
                    },
                    async () => {
                        const models = await listAllModels();
                        const modelId = models[0]?.id;
                        if (!modelId) {
                            return {
                                ok: false as const,
                                message:
                                    'No models are reachable with this key.',
                            };
                        }
                        return probeCompletion({
                            baseUrl: config.baseUrl,
                            apiKey,
                            headers: config.requestHeaders,
                            modelId,
                        });
                    }
                );
                if (result.ok) {
                    vscode.window.showInformationMessage(
                        `Agent Router answered via ${result.modelId} in ${(result.ms / 1000).toFixed(1)}s. The endpoint and key work end to end.`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        `Agent Router test request failed: ${result.message}`
                    );
                }
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
                const lines = [
                    ...(provider.usage.requestCount > 0
                        ? provider.usage.summarize()
                        : ['No requests this session.']),
                    `Today: ${today.requests} request(s), ${formatCost(today.cost)}`,
                    `Last 7 days: ${week.requests} request(s), ${formatCost(week.cost)}`,
                ];
                // The log keeps the plain-text record; the dashboard is the
                // primary view of the same numbers.
                for (const line of lines) {
                    log.info(line);
                }
                dashboard.show();
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
                    async () =>
                        buildStatusReport({
                            gateway: await gatewayStatus(),
                            providerReport: await providerReport(),
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
                // A new spendWarning threshold changes the bar's colouring.
                updateUsageBar();
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
