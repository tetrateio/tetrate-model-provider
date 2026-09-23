import * as vscode from 'vscode';

import type { RequestLog, RequestRecord } from './requestLog';
import { formatCost, formatTokens } from './usage';

/**
 * The Recent Requests view: one row per completed request from the RequestLog,
 * newest first. The log itself is the model; this class only renders it and
 * relays its change events into the tree.
 */

/** The view id in package.json the extension registers this provider under. */
export const REQUESTS_VIEW_ID = 'tetrate-model-provider.requests';

export class RequestsTreeProvider
    implements vscode.TreeDataProvider<RequestRecord>, vscode.Disposable
{
    private readonly onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.onDidChange.event;
    private readonly subscription: { dispose(): void };

    constructor(private readonly log: RequestLog) {
        this.subscription = log.onDidChange(() => this.onDidChange.fire());
    }

    dispose(): void {
        this.subscription.dispose();
        this.onDidChange.dispose();
    }

    getChildren(record?: RequestRecord): RequestRecord[] {
        // Records have no children; the log already orders newest first.
        return record ? [] : [...this.log.records()];
    }

    getTreeItem(record: RequestRecord): vscode.TreeItem {
        const item = new vscode.TreeItem(
            record.modelId,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = `${formatTokens(record.inputTokens)} → ${formatTokens(record.outputTokens)} · ${
            record.cost === undefined ? 'unpriced' : formatCost(record.cost)
        } · ${formatSeconds(record.durationMs)}`;
        item.tooltip = [
            new Date(record.at).toLocaleTimeString(),
            record.modelId,
            `${formatTokens(record.inputTokens)} input tokens, ${formatTokens(record.outputTokens)} output tokens`,
            ...(record.firstOutputMs !== undefined
                ? [`First output after ${formatSeconds(record.firstOutputMs)}`]
                : []),
            ...(record.finishReason
                ? [`Finish reason: ${record.finishReason}`]
                : []),
            // The service's Request Logs are searchable by this id, so it is
            // the bridge from a local row to the server-side record.
            ...(record.requestId ? [`Request id: ${record.requestId}`] : []),
        ].join('\n');
        item.iconPath = new vscode.ThemeIcon(iconFor(record.finishReason));
        item.contextValue = 'request';
        return item;
    }
}

/**
 * `length` and `content_filter` mean the answer was cut short, which is worth
 * a glance; a clean stop or tool handoff gets a quiet check instead.
 */
function iconFor(finishReason: string | undefined): string {
    if (finishReason === 'length' || finishReason === 'content_filter') {
        return 'warning';
    }
    if (finishReason === 'stop' || finishReason === 'tool_calls') {
        return 'check';
    }
    return 'circle-outline';
}

function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}
