import { describe, expect, it, vi } from 'vitest';

import {
    costOf,
    formatCost,
    formatTokens,
    type RequestUsage,
    UsageTracker,
} from './usage';

const request = (partial: Partial<RequestUsage> = {}): RequestUsage => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...partial,
});

describe('costOf', () => {
    const pricing = { inputPer1M: 2, outputPer1M: 10, cachedPer1M: 0.2 };

    it('prices input, cached input and output at their own rates', () => {
        const cost = costOf(
            request({
                inputTokens: 1_000_000,
                cachedInputTokens: 500_000,
                outputTokens: 100_000,
            }),
            pricing
        );
        // 0.5M uncached at $2 + 0.5M cached at $0.2 + 0.1M out at $10
        expect(cost).toBeCloseTo(1 + 0.1 + 1);
    });

    it('bills cached tokens at the input rate when no cache rate is known', () => {
        const cost = costOf(
            request({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }),
            { inputPer1M: 2, outputPer1M: 10 }
        );
        expect(cost).toBeCloseTo(2);
    });

    it('never lets a cached count above the input count go negative', () => {
        const cost = costOf(
            request({ inputTokens: 100, cachedInputTokens: 200 }),
            pricing
        );
        expect(cost).toBeGreaterThanOrEqual(0);
    });

    it('reports an unknown price as undefined, not as zero', () => {
        expect(costOf(request({ inputTokens: 100 }), undefined)).toBeUndefined();
    });
});

describe('UsageTracker', () => {
    const pricing = { inputPer1M: 2, outputPer1M: 10 };

    it('accumulates per model and totals across models', () => {
        const tracker = new UsageTracker();
        tracker.record(
            'a',
            request({ inputTokens: 1000, outputTokens: 100 }),
            pricing
        );
        tracker.record(
            'a',
            request({ inputTokens: 1000, outputTokens: 100 }),
            pricing
        );
        tracker.record('b', request({ inputTokens: 500 }), undefined);

        expect(tracker.requestCount).toBe(3);
        expect(tracker.totalTokens).toBe(2700);
        expect(tracker.totalCost).toBeCloseTo(2 * (2000 + 1000) / 1_000_000);
        expect(tracker.hasUnpricedRequests).toBe(true);
    });

    it('notifies subscribers with the request record', () => {
        const tracker = new UsageTracker();
        const listener = vi.fn();
        const subscription = tracker.subscribe(listener);

        tracker.record('a', request({ inputTokens: 1_000_000 }), pricing);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({
            modelId: 'a',
            usage: request({ inputTokens: 1_000_000 }),
            cost: 2,
        });

        subscription.dispose();
        tracker.record('a', request(), undefined);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('headlines the cost, marking a total that excludes unpriced requests', () => {
        const tracker = new UsageTracker();
        expect(tracker.headline()).toBe('no requests');

        tracker.record(
            'a',
            request({ inputTokens: 1_000_000 }),
            pricing
        );
        expect(tracker.headline()).toBe('$2.00');

        tracker.record('b', request({ inputTokens: 10 }), undefined);
        expect(tracker.headline()).toBe('$2.00+');
    });

    it('falls back to a token headline when nothing could be priced', () => {
        const tracker = new UsageTracker();
        tracker.record(
            'a',
            request({ inputTokens: 1000, outputTokens: 234 }),
            undefined
        );
        expect(tracker.headline()).toBe('1,234 tokens');
    });

    it('summarizes per model, biggest spender first, with a session total', () => {
        const tracker = new UsageTracker();
        tracker.record(
            'cheap',
            request({ inputTokens: 100, outputTokens: 10 }),
            pricing
        );
        tracker.record(
            'costly',
            request({
                inputTokens: 1_000_000,
                cachedInputTokens: 1000,
                outputTokens: 50_000,
                reasoningTokens: 40_000,
            }),
            pricing
        );
        tracker.record('mystery', request({ inputTokens: 5 }), undefined);

        const lines = tracker.summarize();
        expect(lines[0]).toContain('costly: 1 request(s)');
        expect(lines[0]).toContain('(1,000 cached)');
        expect(lines[0]).toContain('incl. 40,000 reasoning');
        expect(lines[2]).toContain('mystery');
        expect(lines[2]).toContain('price unknown');
        expect(lines[3]).toMatch(/^Session total: 3 request\(s\)/);
        expect(lines[3]).toContain('some requests have no known price');
    });
});

describe('formatting', () => {
    it('keeps sub-cent costs legible', () => {
        expect(formatCost(0)).toBe('$0.0000');
        expect(formatCost(0.00005)).toBe('<$0.0001');
        expect(formatCost(0.0042)).toBe('$0.0042');
        expect(formatCost(1.234)).toBe('$1.23');
    });

    it('groups token counts', () => {
        expect(formatTokens(1234567)).toBe('1,234,567');
    });
});
