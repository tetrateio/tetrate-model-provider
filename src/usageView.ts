import * as vscode from 'vscode';

import type { RequestLog, RequestRecord } from './requestLog';
import { formatCost, formatTokens, type UsageTracker } from './usage';
import type { DayTotals, ModelBreakdownRow, UsageHistory } from './usageHistory';

/**
 * Presentation for the usage data: the status bar's markdown tooltip, the
 * spend-pressure colouring, and the dashboard webview. The builders are pure
 * so they can be tested without an extension host; the panel class at the
 * bottom is the only part that touches webview plumbing.
 */

/** Models shown in the status bar tooltip before the rest is elided. */
const TOOLTIP_MODEL_LIMIT = 5;

/** Windows the dashboard can aggregate over, in days. */
export const DASHBOARD_WINDOWS = [7, 30, 62] as const;

export type SpendLevel = 'none' | 'nearing' | 'passed';

/**
 * How close today's spend is to the configured warning threshold. `nearing`
 * begins at 80%: early enough to act on, late enough not to cry wolf.
 */
export function spendLevel(todayCost: number, threshold: number): SpendLevel {
    if (threshold <= 0) {
        return 'none';
    }
    if (todayCost >= threshold) {
        return 'passed';
    }
    return todayCost >= threshold * 0.8 ? 'nearing' : 'none';
}

/** The ThemeColor for a spend level, or undefined for the default look. */
export function spendBackground(
    level: SpendLevel
): vscode.ThemeColor | undefined {
    if (level === 'passed') {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (level === 'nearing') {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

export type TooltipInput = {
    session: UsageTracker;
    today: { cost: number; requests: number };
    week: { cost: number; requests: number };
    spendWarning: number;
};

/**
 * The status bar hover: a per-model table for the session, the durable
 * today and seven-day figures, and command links, so the numbers that used to
 * need a command and an output-channel visit are one hover away.
 */
export function buildUsageTooltip(input: TooltipInput): vscode.MarkdownString {
    const { session, today, week, spendWarning } = input;
    const lines: string[] = ['**Agent Router usage**', ''];

    const models = session.perModel();
    if (models.length > 0) {
        lines.push('| Model | Requests | Tokens | Cost |');
        lines.push('| :-- | --: | --: | --: |');
        for (const row of models.slice(0, TOOLTIP_MODEL_LIMIT)) {
            const cost =
                row.unpricedRequests === row.requests
                    ? 'unknown'
                    : formatCost(row.cost);
            lines.push(
                `| ${row.modelId} | ${row.requests} | ${formatTokens(row.inputTokens + row.outputTokens)} | ${cost} |`
            );
        }
        if (models.length > TOOLTIP_MODEL_LIMIT) {
            lines.push(
                `| _${models.length - TOOLTIP_MODEL_LIMIT} more…_ | | | |`
            );
        }
        lines.push('');
        lines.push(`Session: ${session.headline()}`);
    } else {
        lines.push('No requests this session.');
    }

    lines.push('');
    lines.push(
        `Today: ${formatCost(today.cost)} (${today.requests} request(s)) · Last 7 days: ${formatCost(week.cost)}`
    );
    if (spendWarning > 0) {
        lines.push('');
        lines.push(
            `Daily warning threshold: ${formatCost(spendWarning)} (${spendLevel(today.cost, spendWarning) === 'none' ? 'below' : 'reached ' + Math.round((today.cost / spendWarning) * 100) + '%'})`
        );
    }
    lines.push('');
    lines.push(
        '[Open dashboard](command:tetrate-model-provider.showUsage) · [Choose models](command:tetrate-model-provider.chooseModels)'
    );

    const markdown = new vscode.MarkdownString(lines.join('\n'));
    // Command links do nothing in a tooltip unless the string is trusted, and
    // both linked commands are this extension's own.
    markdown.isTrusted = {
        enabledCommands: [
            'tetrate-model-provider.showUsage',
            'tetrate-model-provider.chooseModels',
        ],
    };
    return markdown;
}

export type DashboardData = {
    /** Oldest first, one entry per retained day, quiet days included. */
    days: DayTotals[];
    /** Per-model rows keyed by the window length in days. */
    breakdowns: Record<number, ModelBreakdownRow[]>;
    session: ModelBreakdownRow[];
    sessionHeadline: string;
    forecast: {
        /** Today's spend projected to midnight from the intraday rate. */
        projectedToday: number;
        /** Mean daily spend over the trailing 7 full days, today excluded. */
        dailyAverage7: number;
    };
    /** How the recent requests were routed, from the local request log. */
    routing: {
        recent: number;
        fallbacks: number;
        routes: Array<{ modelId: string; servedBy: string; count: number }>;
    };
};

export function dashboardData(
    history: UsageHistory,
    session: UsageTracker,
    now: number = Date.now(),
    recentRequests: readonly RequestRecord[] = []
): DashboardData {
    const breakdowns: Record<number, ModelBreakdownRow[]> = {};
    for (const window of DASHBOARD_WINDOWS) {
        breakdowns[window] = history.breakdown(window, now);
    }
    return {
        days: history.dailyTotals(Math.max(...DASHBOARD_WINDOWS), now),
        breakdowns,
        session: session.perModel(),
        sessionHeadline: session.headline(),
        forecast: forecast(history, now),
        routing: routingOf(recentRequests),
    };
}

/**
 * Fallback routing is otherwise only visible one request at a time; counting
 * the recent log's `servedBy` markers shows whether falling back is the
 * exception or has quietly become the rule.
 */
function routingOf(
    records: readonly RequestRecord[]
): DashboardData['routing'] {
    const byRoute = new Map<
        string,
        { modelId: string; servedBy: string; count: number }
    >();
    let fallbacks = 0;
    for (const record of records) {
        if (!record.servedBy) {
            continue;
        }
        fallbacks += 1;
        const key = JSON.stringify([record.modelId, record.servedBy]);
        const route = byRoute.get(key) ?? {
            modelId: record.modelId,
            servedBy: record.servedBy,
            count: 0,
        };
        route.count += 1;
        byRoute.set(key, route);
    }
    return {
        recent: records.length,
        fallbacks,
        routes: [...byRoute.values()].sort((a, b) => b.count - a.count),
    };
}

function forecast(
    history: UsageHistory,
    now: number
): DashboardData['forecast'] {
    const today = history.today(now);
    const date = new Date(now);
    const midnight = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
    ).getTime();
    const elapsed = now - midnight;
    const hour = 60 * 60 * 1000;
    // Less than an hour into the day the divisor is so small that a single
    // request projects to an absurd figure, so the raw cost is more honest.
    const projectedToday =
        elapsed < hour || today.cost === 0
            ? today.cost
            : today.cost / (elapsed / (24 * hour));

    // Eight days ending today; dropping the last leaves the 7 full days.
    const fullDays = history.dailyTotals(8, now).slice(0, -1);
    const dailyAverage7 =
        fullDays.reduce((sum, day) => sum + day.cost, 0) / 7;

    return { projectedToday, dailyAverage7 };
}

/**
 * The dashboard document. All data is embedded as JSON and the window
 * switching happens client-side, so the panel never round-trips to the
 * extension host after it opens. The inline script carries the nonce the CSP
 * demands; everything else is inline styles on a `default-src 'none'` page.
 */
export function renderUsageDashboard(
    data: DashboardData,
    nonce: string
): string {
    // </script> inside the payload would end the block early; escaping the
    // slash keeps the JSON inert without changing what JSON.parse sees.
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Router Usage</title>
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 0 20px 20px;
    }
    h1 { font-size: 1.3em; font-weight: 600; }
    h2 { font-size: 1.05em; font-weight: 600; margin-top: 1.6em; }
    .toolbar { display: flex; gap: 6px; margin: 10px 0; }
    .toolbar button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer;
    }
    .toolbar button.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .chart {
        display: flex; align-items: flex-end; gap: 2px;
        height: 140px; margin: 8px 0 2px;
    }
    .chart .bar {
        flex: 1 1 0; min-width: 2px;
        background: var(--vscode-charts-blue, #3794ff);
        border-radius: 1px 1px 0 0;
    }
    .chart .bar.today { background: var(--vscode-charts-green, #89d185); }
    .chart .bar.empty { background: var(--vscode-widget-border, #454545); height: 1px !important; }
    .axis {
        display: flex; justify-content: space-between;
        font-size: 0.85em; color: var(--vscode-descriptionForeground);
    }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { text-align: right; padding: 3px 10px; }
    th:first-child, td:first-child { text-align: left; padding-left: 0; }
    th {
        color: var(--vscode-descriptionForeground);
        font-weight: 600; border-bottom: 1px solid var(--vscode-widget-border, #454545);
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .note { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 1.5em; }
</style>
</head>
<body>
    <h1>Agent Router usage</h1>

    <h2>Daily spend</h2>
    <div class="toolbar" id="windows"></div>
    <div class="chart" id="chart"></div>
    <div class="axis"><span id="axis-start"></span><span id="axis-end"></span></div>
    <div class="muted" id="chart-summary"></div>
    <div class="muted" id="forecast"></div>

    <h2>By model</h2>
    <table id="models">
        <thead><tr>
            <th>Model</th><th>Requests</th><th>Input</th><th>Cached</th>
            <th>Output</th><th>Reasoning</th><th>Cost</th>
        </tr></thead>
        <tbody></tbody>
    </table>

    <h2>Routing</h2>
    <div class="muted" id="routing-summary"></div>
    <ul id="routing-routes" class="muted"></ul>

    <h2>This session</h2>
    <div class="muted" id="session-headline"></div>
    <table id="session">
        <thead><tr>
            <th>Model</th><th>Requests</th><th>Input</th><th>Cached</th>
            <th>Output</th><th>Reasoning</th><th>Cost</th>
        </tr></thead>
        <tbody></tbody>
    </table>

    <p class="note">
        Costs are estimated from the public catalog's prices; the Agent Router
        dashboard is the billing authority. Requests whose model has no known
        price are counted but not priced.
    </p>

    <script nonce="${nonce}">
        let data = JSON.parse(${JSON.stringify(payload)});
        const fmt = (n) => n.toLocaleString('en-US');
        const cost = (c) => c > 0 && c < 0.0001
            ? '<$0.0001'
            : '$' + c.toFixed(c >= 1 ? 2 : 4);

        function fillTable(tbody, rows) {
            tbody.textContent = '';
            if (rows.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 7;
                td.className = 'muted';
                td.textContent = 'No requests recorded.';
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
            }
            for (const row of rows) {
                const tr = document.createElement('tr');
                const cells = [
                    row.modelId,
                    fmt(row.requests),
                    fmt(row.inputTokens),
                    fmt(row.cachedInputTokens),
                    fmt(row.outputTokens),
                    fmt(row.reasoningTokens),
                    row.unpricedRequests === row.requests
                        ? 'unknown'
                        : cost(row.cost),
                ];
                for (const value of cells) {
                    const td = document.createElement('td');
                    td.textContent = value;
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
        }

        // Remembered so a data push from the extension re-renders the window
        // the user is looking at rather than snapping back to the default.
        let currentWindow = 7;

        function render(windowDays) {
            currentWindow = windowDays;
            const days = data.days.slice(-windowDays);
            const max = Math.max(...days.map((d) => d.cost), 0);

            const chart = document.getElementById('chart');
            chart.textContent = '';
            days.forEach((day, index) => {
                const bar = document.createElement('div');
                bar.className = 'bar'
                    + (index === days.length - 1 ? ' today' : '')
                    + (day.cost === 0 ? ' empty' : '');
                bar.style.height = max > 0
                    ? Math.max(2, Math.round((day.cost / max) * 100)) + '%'
                    : '1px';
                bar.title = day.day + ': ' + cost(day.cost)
                    + ', ' + fmt(day.requests) + ' request(s)';
                chart.appendChild(bar);
            });

            document.getElementById('axis-start').textContent = days[0]?.day ?? '';
            document.getElementById('axis-end').textContent =
                days[days.length - 1]?.day ?? '';

            const total = days.reduce((sum, d) => sum + d.cost, 0);
            const requests = days.reduce((sum, d) => sum + d.requests, 0);
            document.getElementById('chart-summary').textContent =
                'Last ' + windowDays + ' days: ' + cost(total)
                + ' across ' + fmt(requests) + ' request(s).';
            document.getElementById('forecast').textContent =
                'Projected today: ' + cost(data.forecast.projectedToday)
                + ' · 7-day average: ' + cost(data.forecast.dailyAverage7)
                + '/day';

            fillTable(
                document.querySelector('#models tbody'),
                data.breakdowns[windowDays] ?? []
            );
            for (const button of document.querySelectorAll('#windows button')) {
                button.classList.toggle(
                    'active',
                    Number(button.dataset.days) === windowDays
                );
            }
        }

        const toolbar = document.getElementById('windows');
        for (const days of Object.keys(data.breakdowns).map(Number).sort((a, b) => a - b)) {
            const button = document.createElement('button');
            button.textContent = days + ' days';
            button.dataset.days = String(days);
            button.addEventListener('click', () => render(days));
            toolbar.appendChild(button);
        }

        function renderSession() {
            document.getElementById('session-headline').textContent =
                'Session total: ' + data.sessionHeadline;
            fillTable(document.querySelector('#session tbody'), data.session);
        }

        function renderRouting() {
            const routing = data.routing || { recent: 0, fallbacks: 0, routes: [] };
            document.getElementById('routing-summary').textContent =
                routing.recent === 0
                    ? 'No recent requests recorded.'
                    : routing.fallbacks === 0
                      ? 'All ' + fmt(routing.recent)
                        + ' recent request(s) were answered by the requested model.'
                      : fmt(routing.fallbacks) + ' of ' + fmt(routing.recent)
                        + ' recent request(s) were served by a fallback or override.';
            const list = document.getElementById('routing-routes');
            list.textContent = '';
            for (const route of routing.routes) {
                const item = document.createElement('li');
                item.textContent = route.modelId + ' → ' + route.servedBy
                    + ' × ' + fmt(route.count);
                list.appendChild(item);
            }
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message && message.type === 'data') {
                data = message.data;
                renderSession();
                renderRouting();
                render(currentWindow);
            }
        });

        renderSession();
        renderRouting();
        render(7);
    </script>
</body>
</html>`;
}

/**
 * The dashboard panel, one per window. Reopening the command reveals and
 * refreshes the existing panel rather than stacking a second one.
 */
export class UsageDashboard {
    private panel?: vscode.WebviewPanel;

    constructor(
        private readonly history: UsageHistory,
        private readonly session: UsageTracker,
        private readonly requestLog?: RequestLog
    ) {}

    private data(): DashboardData {
        return dashboardData(
            this.history,
            this.session,
            Date.now(),
            this.requestLog?.records() ?? []
        );
    }

    show(): void {
        const html = renderUsageDashboard(this.data(), nonce());
        if (this.panel) {
            this.panel.webview.html = html;
            this.panel.reveal();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'tetrateAgentRouterUsage',
            'Agent Router Usage',
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );
        this.panel.webview.html = html;
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /**
     * Pushes fresh data into an open panel; a no-op otherwise. A hidden panel
     * misses the message, which is fine: the next show() rebuilds the HTML.
     */
    update(): void {
        if (!this.panel) {
            return;
        }
        void this.panel.webview.postMessage({
            type: 'data',
            data: this.data(),
        });
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }
}

function nonce(): string {
    return Array.from({ length: 32 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
            Math.floor(Math.random() * 62)
        )
    ).join('');
}
