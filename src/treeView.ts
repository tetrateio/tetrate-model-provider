import * as vscode from 'vscode';

import { CONFIG_SECTION, getConfig, isIncludedByFilter } from './config';
import { formatAge } from './diagnostics';
import {
    describeGateway,
    describeProvider,
    type GatewayStatus,
    type ProviderReport,
} from './health';
import { formatContext } from './modelPicker';
import { formatCost, type UsageTracker } from './usage';
import type { UsageHistory } from './usageHistory';

/**
 * The Overview tree in the activity bar: endpoint health, the offered models
 * grouped by provider, and the usage figures, in one durable surface instead
 * of three commands. When no key is stored the tree reports itself empty, so
 * the `viewsWelcome` contribution takes over with the onboarding buttons.
 */

export type TreeNode =
    | { kind: 'root'; id: 'endpoint' | 'models' | 'usage' }
    | {
          kind: 'leaf';
          label: string;
          description?: string;
          tooltip?: string;
          icon?: string;
          command?: string;
      }
    | { kind: 'profiles' }
    | { kind: 'profile'; name: string; url: string }
    | { kind: 'providerHealth' }
    // `allIncluded` is computed while listing, because getTreeItem is
    // synchronous and cannot await the model list to derive it there.
    | { kind: 'family'; name: string; allIncluded: boolean }
    | { kind: 'model'; info: vscode.LanguageModelChatInformation };

export type TreeDeps = {
    /** Whether a key is stored for the configured endpoint. */
    hasKey(baseUrl: string): Promise<boolean>;
    /**
     * Every model the key can reach, ignoring the filter; the tree shows them
     * all so the checkboxes can re-include what the filter currently hides.
     */
    listAllModels(): Promise<readonly vscode.LanguageModelChatInformation[]>;
    /** The cached public catalog's age and size, when one is stored. */
    catalogInfo(): { fetchedAt: number; entries: number } | undefined;
    /** Median time to first output, when the model has answered this session. */
    latencyOf(
        modelId: string
    ): { medianMs: number; samples: number } | undefined;
    /** The unauthenticated gateway status document; expected to be memoized. */
    gatewayStatus(): Promise<GatewayStatus>;
    /** Per-provider health from /v1/status; undefined when not served. */
    providerReport(): Promise<ProviderReport | undefined>;
    session: UsageTracker;
    history: UsageHistory;
};

/** The tree icon for the gateway row; mirrors describeGateway's states. */
function gatewayIcon(status: GatewayStatus): string {
    if (!status.reachable || status.status === 'not_serving') {
        return 'error';
    }
    if (status.status === 'unknown') {
        return 'warning';
    }
    return 'check';
}

export class AgentRouterTreeProvider
    implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
    private readonly onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.onDidChange.event;

    constructor(private readonly deps: TreeDeps) {}

    refresh(): void {
        this.onDidChange.fire();
    }

    dispose(): void {
        this.onDidChange.dispose();
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (!node) {
            // Empty means the viewsWelcome onboarding is shown instead.
            if (!(await this.deps.hasKey(getConfig().baseUrl))) {
                return [];
            }
            return [
                { kind: 'root', id: 'endpoint' },
                { kind: 'root', id: 'models' },
                { kind: 'root', id: 'usage' },
            ];
        }
        if (node.kind === 'root') {
            if (node.id === 'endpoint') {
                return this.endpointChildren();
            }
            if (node.id === 'models') {
                return this.modelChildren();
            }
            return this.usageChildren();
        }
        if (node.kind === 'profiles') {
            return this.profileChildren();
        }
        if (node.kind === 'providerHealth') {
            return this.providerChildren();
        }
        if (node.kind === 'family') {
            const models = await this.deps.listAllModels();
            return models
                .filter((info) => (info.family || 'other') === node.name)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((info) => ({ kind: 'model', info }) as TreeNode);
        }
        return [];
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'root') {
            const labels = {
                endpoint: 'Endpoint',
                models: 'Models',
                usage: 'Usage',
            };
            const item = new vscode.TreeItem(
                labels[node.id],
                node.id === 'endpoint'
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = node.id;
            return item;
        }
        if (node.kind === 'profiles') {
            const item = new vscode.TreeItem(
                'Profiles',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'profiles';
            return item;
        }
        if (node.kind === 'providerHealth') {
            const item = new vscode.TreeItem(
                'Providers',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.tooltip =
                'Per-provider health over the gateway’s recent observation window.';
            return item;
        }
        if (node.kind === 'profile') {
            const item = new vscode.TreeItem(
                node.name,
                vscode.TreeItemCollapsibleState.None
            );
            item.description =
                node.url === getConfig().baseUrl
                    ? `${node.url} (current)`
                    : node.url;
            item.contextValue = 'profile';
            item.iconPath = new vscode.ThemeIcon('server-environment');
            // The node travels as the command argument so the handler knows
            // which profile was clicked; see profileNameOf in profileCommands.
            item.command = {
                command: 'tetrate-model-provider.switchEndpoint',
                title: node.name,
                arguments: [node],
            };
            return item;
        }
        if (node.kind === 'family') {
            const item = new vscode.TreeItem(
                node.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'family';
            item.checkboxState = node.allIncluded
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            return item;
        }
        if (node.kind === 'model') {
            const item = new vscode.TreeItem(
                node.info.name,
                vscode.TreeItemCollapsibleState.None
            );
            item.contextValue = 'model';
            item.checkboxState = isIncludedByFilter(
                node.info.id,
                getConfig().modelFilter
            )
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            const latency = this.deps.latencyOf(node.info.id);
            item.description = `${node.info.id} · ${formatContext(node.info)}${
                latency ? ` · ~${formatSeconds(latency.medianMs)}` : ''
            }`;
            item.tooltip = latency
                ? [
                      ...(node.info.tooltip ? [node.info.tooltip] : []),
                      `Median first output: ${formatSeconds(latency.medianMs)} over ${latency.samples} request(s).`,
                  ].join('\n')
                : node.info.tooltip;
            return item;
        }
        const item = new vscode.TreeItem(
            node.label,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = node.description;
        item.tooltip = node.tooltip;
        if (node.icon) {
            item.iconPath = new vscode.ThemeIcon(node.icon);
        }
        if (node.command) {
            item.command = {
                command: node.command,
                title: node.label,
            };
        }
        return item;
    }

    /**
     * Applies checkbox toggles to the `modelFilter` setting. Every id included
     * writes `[]` so newly published upstream models keep being offered; a
     * fully empty selection is rejected because an empty filter means the
     * opposite of "none" — the caller warns and refreshes to snap the boxes
     * back to the stored state.
     */
    async applyCheckboxChanges(
        changes: ReadonlyArray<[TreeNode, boolean]>
    ): Promise<'applied' | 'rejected-empty'> {
        const models = await this.deps.listAllModels();
        const filter = getConfig().modelFilter;
        const included = new Set(
            models
                .filter((info) => isIncludedByFilter(info.id, filter))
                .map((info) => info.id)
        );
        for (const [node, checked] of changes) {
            const ids =
                node.kind === 'model'
                    ? [node.info.id]
                    : node.kind === 'family'
                      ? models
                            .filter(
                                (info) =>
                                    (info.family || 'other') === node.name
                            )
                            .map((info) => info.id)
                      : [];
            for (const id of ids) {
                if (checked) {
                    included.add(id);
                } else {
                    included.delete(id);
                }
            }
        }
        if (included.size === 0) {
            return 'rejected-empty';
        }
        const value =
            included.size === models.length
                ? []
                : models
                      .filter((info) => included.has(info.id))
                      .map((info) => info.id);
        await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update('modelFilter', value, vscode.ConfigurationTarget.Global);
        this.onDidChange.fire();
        return 'applied';
    }

    private async endpointChildren(): Promise<TreeNode[]> {
        const config = getConfig();
        const profile = Object.entries(config.profiles).find(
            ([, url]) => url === config.baseUrl
        )?.[0];
        const catalog = this.deps.catalogInfo();
        const gateway = await this.deps.gatewayStatus();
        return [
            {
                kind: 'leaf',
                label: profile ?? 'Base URL',
                description: config.baseUrl,
                tooltip: 'Click to switch endpoints.',
                icon: 'globe',
                command: 'tetrate-model-provider.switchEndpoint',
            },
            {
                kind: 'leaf',
                label: 'Gateway',
                description: describeGateway(gateway),
                tooltip:
                    'The gateway’s own health, independent of the API key. Click for the full report.',
                icon: gatewayIcon(gateway),
                command: 'tetrate-model-provider.showStatus',
            },
            {
                kind: 'leaf',
                label: 'API key',
                description: 'stored in secret storage',
                tooltip: 'Click to replace the key for this endpoint.',
                icon: 'key',
                command: 'tetrate-model-provider.setApiKey',
            },
            {
                kind: 'leaf',
                label: 'Catalog',
                description: catalog
                    ? `${catalog.entries} entries, ${formatAge(Date.now() - catalog.fetchedAt)} old`
                    : 'not cached yet',
                tooltip: 'Click to refresh the model list and catalog.',
                icon: 'database',
                command: 'tetrate-model-provider.refreshModels',
            },
            { kind: 'providerHealth' },
            { kind: 'profiles' },
        ];
    }

    private async providerChildren(): Promise<TreeNode[]> {
        const report = await this.deps.providerReport();
        if (!report || report.providers.length === 0) {
            return [
                {
                    kind: 'leaf',
                    label: 'No provider report',
                    description: 'this gateway does not serve /v1/status',
                    icon: 'circle-outline',
                },
            ];
        }
        return report.providers.map((provider) => ({
            kind: 'leaf',
            label: provider.name,
            description: describeProvider(provider),
            icon:
                provider.reachable === true
                    ? 'check'
                    : provider.reachable === false
                      ? 'error'
                      : 'circle-outline',
            command: 'tetrate-model-provider.showStatus',
        }));
    }

    private profileChildren(): TreeNode[] {
        const entries = Object.entries(getConfig().profiles);
        if (entries.length === 0) {
            return [
                {
                    kind: 'leaf',
                    label: 'Add profile…',
                    icon: 'add',
                    command: 'tetrate-model-provider.addProfile',
                },
            ];
        }
        return entries.map(([name, url]) => ({ kind: 'profile', name, url }));
    }

    private async modelChildren(): Promise<TreeNode[]> {
        const models = await this.deps.listAllModels();
        if (models.length === 0) {
            return [
                {
                    kind: 'leaf',
                    label: 'No models offered',
                    description: 'check the filter or the connection',
                    icon: 'warning',
                    command: 'tetrate-model-provider.showStatus',
                },
            ];
        }
        const filter = getConfig().modelFilter;
        const families = [
            ...new Set(models.map((info) => info.family || 'other')),
        ].sort((a, b) => a.localeCompare(b));
        return families.map((name) => ({
            kind: 'family',
            name,
            allIncluded: models
                .filter((info) => (info.family || 'other') === name)
                .every((info) => isIncludedByFilter(info.id, filter)),
        }));
    }

    private usageChildren(): TreeNode[] {
        const today = this.deps.history.today();
        const week = this.deps.history.window(7);
        return [
            {
                kind: 'leaf',
                label: 'Session',
                description: this.deps.session.headline(),
                icon: 'pulse',
                command: 'tetrate-model-provider.showUsage',
            },
            {
                kind: 'leaf',
                label: 'Today',
                description: `${formatCost(today.cost)} · ${today.requests} request(s)`,
                icon: 'calendar',
                command: 'tetrate-model-provider.showUsage',
            },
            {
                kind: 'leaf',
                label: 'Last 7 days',
                description: `${formatCost(week.cost)} · ${week.requests} request(s)`,
                icon: 'graph',
                command: 'tetrate-model-provider.showUsage',
            },
        ];
    }
}

/** One decimal reads naturally for sub-10s latencies, e.g. `0.8s`. */
function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}
