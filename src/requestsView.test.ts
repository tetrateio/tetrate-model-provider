import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { RequestLog, type RequestRecord } from './requestLog';
import { REQUESTS_VIEW_ID, RequestsTreeProvider } from './requestsView';

function record(partial: Partial<RequestRecord> = {}): RequestRecord {
    return {
        at: Date.parse('2026-09-23T10:00:00Z'),
        modelId: 'claude-opus-5',
        inputTokens: 1200,
        outputTokens: 34,
        cost: 0.0031,
        durationMs: 4200,
        ...partial,
    };
}

describe('RequestsTreeProvider', () => {
    it('exports the view id the extension registers against', () => {
        expect(REQUESTS_VIEW_ID).toBe('tetrate-model-provider.requests');
    });

    it('returns nothing for an empty log', () => {
        const view = new RequestsTreeProvider(new RequestLog());
        expect(view.getChildren()).toEqual([]);
    });

    it('lists the log records and gives them no children', () => {
        const log = new RequestLog();
        log.add(record());
        const view = new RequestsTreeProvider(log);
        const [first] = view.getChildren();
        expect(first?.modelId).toBe('claude-opus-5');
        expect(view.getChildren(first)).toEqual([]);
    });

    it('renders counts, cost, and duration in the description', () => {
        const view = new RequestsTreeProvider(new RequestLog());
        const item = view.getTreeItem(
            record({ finishReason: 'stop', firstOutputMs: 800 })
        );
        expect(item.label).toBe('claude-opus-5');
        expect(item.description).toBe('1,200 → 34 · $0.0031 · 4.2s');
        expect(item.contextValue).toBe('request');
        expect(item.tooltip).toContain('1,200 input tokens, 34 output tokens');
        expect(item.tooltip).toContain('First output after 0.8s');
        expect(item.tooltip).toContain('Finish reason: stop');
    });

    it('shows unpriced when the model has no known price', () => {
        const view = new RequestsTreeProvider(new RequestLog());
        const item = view.getTreeItem(record({ cost: undefined }));
        expect(item.description).toBe('1,200 → 34 · unpriced · 4.2s');
    });

    it('picks the icon from the finish reason', () => {
        const view = new RequestsTreeProvider(new RequestLog());
        const iconOf = (finishReason?: string) =>
            (view.getTreeItem(record({ finishReason }))
                .iconPath as vscode.ThemeIcon).id;
        expect(iconOf('length')).toBe('warning');
        expect(iconOf('content_filter')).toBe('warning');
        expect(iconOf('stop')).toBe('check');
        expect(iconOf('tool_calls')).toBe('check');
        expect(iconOf(undefined)).toBe('circle-outline');
    });

    it('fires its change event when the log adds a record', () => {
        const log = new RequestLog();
        const view = new RequestsTreeProvider(log);
        let fired = 0;
        view.onDidChangeTreeData(() => {
            fired += 1;
        });
        log.add(record());
        expect(fired).toBe(1);

        // After dispose, the log no longer reaches the view.
        view.dispose();
        log.add(record());
        expect(fired).toBe(1);
    });
});
