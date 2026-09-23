import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { AgentRouterTreeProvider, type TreeDeps, type TreeNode } from './treeView';
import { UsageTracker } from './usage';
import { UsageHistory, USAGE_HISTORY_KEY } from './usageHistory';

const { configValues } = vscode as unknown as {
    configValues: Record<string, unknown>;
};

function makeStore() {
    let value: unknown;
    return {
        get<T>(key: string): T | undefined {
            return key === USAGE_HISTORY_KEY ? (value as T) : undefined;
        },
        update(key: string, next: unknown) {
            if (key === USAGE_HISTORY_KEY) {
                value = next;
            }
            return Promise.resolve();
        },
    };
}

function model(
    id: string,
    family: string
): vscode.LanguageModelChatInformation {
    return {
        id,
        name: id,
        family,
        version: '1.0',
        maxInputTokens: 100_000,
        maxOutputTokens: 28_000,
        capabilities: {},
    } as vscode.LanguageModelChatInformation;
}

function makeProvider(overrides: Partial<TreeDeps> = {}) {
    return new AgentRouterTreeProvider({
        hasKey: () => Promise.resolve(true),
        listAllModels: () =>
            Promise.resolve([
                model('gpt-5-mini', 'openai'),
                model('claude-opus-5', 'anthropic'),
            ]),
        catalogInfo: () => ({ fetchedAt: Date.now(), entries: 210 }),
        latencyOf: () => undefined,
        session: new UsageTracker(),
        history: new UsageHistory(makeStore()),
        ...overrides,
    });
}

beforeEach(() => {
    for (const key of Object.keys(configValues)) {
        delete configValues[key];
    }
});

describe('AgentRouterTreeProvider', () => {
    it('reports itself empty without a key, so the welcome view shows', async () => {
        const tree = makeProvider({ hasKey: () => Promise.resolve(false) });
        await expect(tree.getChildren()).resolves.toEqual([]);
    });

    it('offers the three roots when a key is stored', async () => {
        const roots = await makeProvider().getChildren();
        expect(roots).toEqual([
            { kind: 'root', id: 'endpoint' },
            { kind: 'root', id: 'models' },
            { kind: 'root', id: 'usage' },
        ]);
    });

    it('describes the endpoint, key, catalog, and profiles with their commands', async () => {
        const tree = makeProvider();
        const children = await tree.getChildren({
            kind: 'root',
            id: 'endpoint',
        });
        const items = children.map((node) => tree.getTreeItem(node));

        expect(items[0]?.label).toBe('Base URL');
        expect(items[0]?.description).toContain('api.router.tetrate.ai');
        expect(items[0]?.command?.command).toBe(
            'tetrate-model-provider.switchEndpoint'
        );
        expect(items[1]?.command?.command).toBe(
            'tetrate-model-provider.setApiKey'
        );
        expect(items[2]?.description).toContain('210 entries');
        expect(items[3]?.label).toBe('Profiles');
        expect(items[3]?.contextValue).toBe('profiles');
    });

    it('names the profile when the base URL matches one', async () => {
        configValues.profiles = {
            Production: 'https://api.router.tetrate.ai/v1',
        };
        const tree = makeProvider();
        const [endpoint] = await tree.getChildren({
            kind: 'root',
            id: 'endpoint',
        });
        expect(tree.getTreeItem(endpoint!).label).toBe('Production');
    });

    it('lists profiles beneath the Profiles row, marking the current one', async () => {
        configValues.profiles = {
            Production: 'https://api.router.tetrate.ai/v1',
            Staging: 'https://staging.example.com/v1',
        };
        const tree = makeProvider();
        const children = await tree.getChildren({ kind: 'profiles' });
        const items = children.map((node) => tree.getTreeItem(node));

        expect(items.map((item) => item.label)).toEqual([
            'Production',
            'Staging',
        ]);
        expect(items[0]?.description).toBe(
            'https://api.router.tetrate.ai/v1 (current)'
        );
        expect(items[1]?.description).toBe('https://staging.example.com/v1');
        expect(items[0]?.contextValue).toBe('profile');
        expect(items[0]?.command?.command).toBe(
            'tetrate-model-provider.switchEndpoint'
        );
        expect(items[0]?.command?.arguments?.[0]).toEqual({
            kind: 'profile',
            name: 'Production',
            url: 'https://api.router.tetrate.ai/v1',
        });
        expect((items[0]?.iconPath as vscode.ThemeIcon).id).toBe(
            'server-environment'
        );
    });

    it('offers the add flow when no profiles exist', async () => {
        const tree = makeProvider();
        const [child] = await tree.getChildren({ kind: 'profiles' });
        const item = tree.getTreeItem(child!);
        expect(item.label).toBe('Add profile…');
        expect(item.command?.command).toBe('tetrate-model-provider.addProfile');
    });

    it('groups all models by family and lists them beneath', async () => {
        const tree = makeProvider();
        const families = await tree.getChildren({ kind: 'root', id: 'models' });
        expect(families).toEqual([
            { kind: 'family', name: 'anthropic', allIncluded: true },
            { kind: 'family', name: 'openai', allIncluded: true },
        ]);

        const anthropic = await tree.getChildren(families[0]);
        const leaf = tree.getTreeItem(anthropic[0]!);
        expect(leaf.label).toBe('claude-opus-5');
        expect(leaf.description).toContain('128K');
    });

    it('checks model and family boxes to mirror the filter', async () => {
        configValues.modelFilter = ['gpt-*'];
        const tree = makeProvider();
        const families = (await tree.getChildren({
            kind: 'root',
            id: 'models',
        })) as Extract<TreeNode, { kind: 'family' }>[];

        const anthropic = tree.getTreeItem(
            families.find((family) => family.name === 'anthropic')!
        );
        const openai = tree.getTreeItem(
            families.find((family) => family.name === 'openai')!
        );
        expect(anthropic.contextValue).toBe('family');
        expect(anthropic.checkboxState).toBe(
            vscode.TreeItemCheckboxState.Unchecked
        );
        expect(openai.checkboxState).toBe(
            vscode.TreeItemCheckboxState.Checked
        );

        const [claude] = await tree.getChildren(
            families.find((family) => family.name === 'anthropic')
        );
        const [gpt] = await tree.getChildren(
            families.find((family) => family.name === 'openai')
        );
        expect(tree.getTreeItem(claude!).contextValue).toBe('model');
        expect(tree.getTreeItem(claude!).checkboxState).toBe(
            vscode.TreeItemCheckboxState.Unchecked
        );
        expect(tree.getTreeItem(gpt!).checkboxState).toBe(
            vscode.TreeItemCheckboxState.Checked
        );
    });

    it('unchecks a family only when one of its models is excluded', async () => {
        configValues.modelFilter = ['claude-opus-5'];
        const tree = makeProvider({
            listAllModels: () =>
                Promise.resolve([
                    model('claude-opus-5', 'anthropic'),
                    model('claude-haiku-4-5', 'anthropic'),
                ]),
        });
        const [family] = await tree.getChildren({
            kind: 'root',
            id: 'models',
        });
        expect(tree.getTreeItem(family!).checkboxState).toBe(
            vscode.TreeItemCheckboxState.Unchecked
        );
    });

    it('writes the exact ids when a checkbox change leaves a subset', async () => {
        const tree = makeProvider();
        const result = await tree.applyCheckboxChanges([
            [{ kind: 'model', info: model('claude-opus-5', 'anthropic') }, false],
        ]);
        expect(result).toBe('applied');
        expect(configValues.modelFilter).toEqual(['gpt-5-mini']);
    });

    it('writes an empty filter when every model ends up included', async () => {
        configValues.modelFilter = ['gpt-5-mini'];
        const tree = makeProvider();
        const result = await tree.applyCheckboxChanges([
            [{ kind: 'family', name: 'anthropic', allIncluded: false }, true],
        ]);
        expect(result).toBe('applied');
        expect(configValues.modelFilter).toEqual([]);
    });

    it('rejects a change that would exclude every model, writing nothing', async () => {
        const tree = makeProvider();
        const result = await tree.applyCheckboxChanges([
            [{ kind: 'family', name: 'anthropic', allIncluded: true }, false],
            [{ kind: 'family', name: 'openai', allIncluded: true }, false],
        ]);
        expect(result).toBe('rejected-empty');
        expect(configValues.modelFilter).toBeUndefined();
    });

    it('fires the change event after a successful checkbox write', async () => {
        const tree = makeProvider();
        let fired = 0;
        tree.onDidChangeTreeData(() => {
            fired += 1;
        });
        await tree.applyCheckboxChanges([
            [{ kind: 'model', info: model('gpt-5-mini', 'openai') }, false],
        ]);
        expect(fired).toBe(1);
    });

    it('appends the median first-output latency to model rows', async () => {
        const tree = makeProvider({
            latencyOf: (modelId) =>
                modelId === 'gpt-5-mini'
                    ? { medianMs: 840, samples: 3 }
                    : undefined,
        });
        const item = tree.getTreeItem({
            kind: 'model',
            info: model('gpt-5-mini', 'openai'),
        });
        expect(item.description).toContain('· ~0.8s');
        expect(item.tooltip).toContain(
            'Median first output: 0.8s over 3 request(s).'
        );

        const silent = tree.getTreeItem({
            kind: 'model',
            info: model('claude-opus-5', 'anthropic'),
        });
        expect(silent.description).not.toContain('~');
    });

    it('points at the status report when no models are offered', async () => {
        const tree = makeProvider({
            listAllModels: () => Promise.resolve([]),
        });
        const [child] = await tree.getChildren({ kind: 'root', id: 'models' });
        expect(tree.getTreeItem(child!).command?.command).toBe(
            'tetrate-model-provider.showStatus'
        );
    });

    it('summarizes session, today, and the week under usage', async () => {
        const history = new UsageHistory(makeStore());
        await history.record(
            'a',
            {
                inputTokens: 10,
                cachedInputTokens: 0,
                outputTokens: 1,
                reasoningTokens: 0,
            },
            0.5
        );
        const tree = makeProvider({ history });

        const children = await tree.getChildren({ kind: 'root', id: 'usage' });
        const items = children.map((node) => tree.getTreeItem(node));
        expect(items.map((item) => item.label)).toEqual([
            'Session',
            'Today',
            'Last 7 days',
        ]);
        expect(items[1]?.description).toBe('$0.5000 · 1 request(s)');
    });
});
