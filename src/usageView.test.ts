import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { UsageTracker } from './usage';
import { UsageHistory, USAGE_HISTORY_KEY } from './usageHistory';
import {
    buildUsageTooltip,
    DASHBOARD_WINDOWS,
    dashboardData,
    renderUsageDashboard,
    spendBackground,
    spendLevel,
    UsageDashboard,
} from './usageView';

const NOON = new Date(2026, 8, 23, 12, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

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

const usage = {
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 0,
};

describe('spendLevel', () => {
    it('is none when the warning is disabled', () => {
        expect(spendLevel(100, 0)).toBe('none');
    });

    it('starts warning at 80% and escalates past the threshold', () => {
        expect(spendLevel(7.99, 10)).toBe('none');
        expect(spendLevel(8, 10)).toBe('nearing');
        expect(spendLevel(10, 10)).toBe('passed');
    });
});

describe('spendBackground', () => {
    it('maps levels onto the two status bar backgrounds', () => {
        expect(spendBackground('none')).toBeUndefined();
        expect(spendBackground('nearing')).toMatchObject({
            id: 'statusBarItem.warningBackground',
        });
        expect(spendBackground('passed')).toMatchObject({
            id: 'statusBarItem.errorBackground',
        });
    });
});

describe('buildUsageTooltip', () => {
    const pricing = { inputPer1M: 2, outputPer1M: 10 };

    function tooltip(overrides: { spendWarning?: number } = {}) {
        const session = new UsageTracker();
        session.record('claude-test', usage, pricing);
        session.record('mystery', usage, undefined);
        return buildUsageTooltip({
            session,
            today: { cost: 0.5, requests: 3 },
            week: { cost: 2.25, requests: 12 },
            spendWarning: overrides.spendWarning ?? 0,
        });
    }

    it('tables the session per model and adds the durable figures', () => {
        const markdown = tooltip();
        expect(markdown.value).toContain('| Model | Requests | Tokens | Cost |');
        expect(markdown.value).toContain('| claude-test | 1 | 1,100 |');
        expect(markdown.value).toContain('| mystery | 1 | 1,100 | unknown |');
        expect(markdown.value).toContain('Today: $0.50');
        expect(markdown.value).toContain('Last 7 days: $2.25');
    });

    it('links only this extension’s own commands as trusted', () => {
        const markdown = tooltip();
        expect(markdown.value).toContain(
            'command:tetrate-model-provider.showUsage'
        );
        expect(markdown.isTrusted).toEqual({
            enabledCommands: [
                'tetrate-model-provider.showUsage',
                'tetrate-model-provider.chooseModels',
            ],
        });
    });

    it('shows progress toward a configured warning threshold', () => {
        expect(tooltip({ spendWarning: 10 }).value).toContain(
            'Daily warning threshold: $10.00'
        );
    });

    it('says so when the session has no requests yet', () => {
        const markdown = buildUsageTooltip({
            session: new UsageTracker(),
            today: { cost: 0, requests: 0 },
            week: { cost: 0, requests: 0 },
            spendWarning: 0,
        });
        expect(markdown.value).toContain('No requests this session.');
    });
});

describe('dashboardData', () => {
    it('assembles the days, windowed breakdowns, and session rows', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('a', usage, 1, NOON);
        const session = new UsageTracker();
        session.record('b', usage, { inputPer1M: 2, outputPer1M: 10 });

        const data = dashboardData(history, session, NOON);

        expect(data.days).toHaveLength(Math.max(...DASHBOARD_WINDOWS));
        expect(data.days[data.days.length - 1]).toMatchObject({
            cost: 1,
            requests: 1,
        });
        for (const window of DASHBOARD_WINDOWS) {
            expect(data.breakdowns[window]?.[0]).toMatchObject({
                modelId: 'a',
            });
        }
        expect(data.session[0]).toMatchObject({ modelId: 'b' });
        expect(data.sessionHeadline).toBe(session.headline());
    });

    it('projects today from the elapsed fraction of the day', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('a', usage, 3, NOON);

        const sixPm = new Date(2026, 8, 23, 18, 0, 0).getTime();
        const data = dashboardData(history, new UsageTracker(), sixPm);

        expect(data.forecast.projectedToday).toBeCloseTo(4);
    });

    it('does not project from less than an hour of the day', async () => {
        const history = new UsageHistory(makeStore());
        const halfPastMidnight = new Date(2026, 8, 23, 0, 30, 0).getTime();
        await history.record('a', usage, 3, halfPastMidnight);

        const data = dashboardData(
            history,
            new UsageTracker(),
            halfPastMidnight
        );

        expect(data.forecast.projectedToday).toBe(3);
    });

    it('falls back to zero rather than projecting a costless day', () => {
        const history = new UsageHistory(makeStore());
        const sixPm = new Date(2026, 8, 23, 18, 0, 0).getTime();

        const data = dashboardData(history, new UsageTracker(), sixPm);

        expect(data.forecast.projectedToday).toBe(0);
    });

    it('averages the seven full days before today', async () => {
        const history = new UsageHistory(makeStore());
        // Oldest first: pruning trims days after the recording timestamp.
        // The eighth day back falls outside the window.
        await history.record('a', usage, 50, NOON - 8 * DAY_MS);
        await history.record('a', usage, 7, NOON - 7 * DAY_MS);
        await history.record('a', usage, 14, NOON - DAY_MS);
        // Today must not leak into the trailing average.
        await history.record('a', usage, 100, NOON);

        const data = dashboardData(history, new UsageTracker(), NOON);

        expect(data.forecast.dailyAverage7).toBeCloseTo(21 / 7);
    });
});

describe('renderUsageDashboard', () => {
    it('embeds the data and the nonce the CSP requires', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('claude-test', usage, 1, NOON);
        const html = renderUsageDashboard(
            dashboardData(history, new UsageTracker(), NOON),
            'NONCE123'
        );

        expect(html).toContain('script-src \'nonce-NONCE123\'');
        expect(html).toContain('<script nonce="NONCE123">');
        expect(html).toContain('claude-test');
        expect(html).toContain('default-src \'none\'');
    });

    it('keeps a hostile model id from closing the script block', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('</script><img src=x>', usage, 1, NOON);
        const html = renderUsageDashboard(
            dashboardData(history, new UsageTracker(), NOON),
            'NONCE123'
        );

        // One closing tag for the inline script itself, none from the data.
        expect(html.match(/<\/script>/g)).toHaveLength(1);
    });

    it('carries the forecast line and the live-update listener', () => {
        const html = renderUsageDashboard(
            dashboardData(new UsageHistory(makeStore()), new UsageTracker(), NOON),
            'NONCE123'
        );

        expect(html).toContain('id="forecast"');
        expect(html).toContain('Projected today: ');
        expect(html).toContain('7-day average: ');
        expect(html).toContain('addEventListener(\'message\'');
    });
});

describe('UsageDashboard.update', () => {
    type FakePanel = {
        webview: {
            html: string;
            postMessage: (message: unknown) => Thenable<boolean>;
        };
        reveal: () => void;
        onDidDispose: () => { dispose(): void };
        dispose: () => void;
    };

    function showWithFakePanel(dashboard: UsageDashboard): unknown[] {
        const posted: unknown[] = [];
        const panel: FakePanel = {
            webview: {
                html: '',
                postMessage: (message) => {
                    posted.push(message);
                    return Promise.resolve(true);
                },
            },
            reveal() {},
            onDidDispose: () => ({ dispose() {} }),
            dispose() {},
        };
        const original = vscode.window.createWebviewPanel;
        (vscode.window as { createWebviewPanel: unknown }).createWebviewPanel =
            () => panel;
        try {
            dashboard.show();
        } finally {
            (
                vscode.window as { createWebviewPanel: unknown }
            ).createWebviewPanel = original;
        }
        return posted;
    }

    it('posts one data message into the open panel', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('a', usage, 1, NOON);
        const dashboard = new UsageDashboard(history, new UsageTracker());
        const posted = showWithFakePanel(dashboard);

        dashboard.update();

        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ type: 'data' });
        expect(
            (posted[0] as { data: { forecast: unknown } }).data.forecast
        ).toBeDefined();
    });

    it('is a no-op before the panel exists', () => {
        const dashboard = new UsageDashboard(
            new UsageHistory(makeStore()),
            new UsageTracker()
        );
        expect(() => dashboard.update()).not.toThrow();
    });
});
