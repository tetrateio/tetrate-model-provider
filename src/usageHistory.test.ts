import { describe, expect, it } from 'vitest';

import type { RequestUsage } from './usage';
import {
    dayKeyOf,
    USAGE_HISTORY_KEY,
    USAGE_RETENTION_DAYS,
    UsageHistory,
} from './usageHistory';

// Noon local time avoids midnight edges when tests step across days.
const NOON = new Date(2026, 8, 23, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const usage = (partial: Partial<RequestUsage> = {}): RequestUsage => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...partial,
});

function makeStore(initial?: unknown) {
    let value = initial;
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
        read: () => value,
    };
}

describe('UsageHistory', () => {
    it('accumulates today and persists across instances', async () => {
        const store = makeStore();
        const first = new UsageHistory(store);
        await first.record('a', usage({ inputTokens: 10 }), 0.5, NOON);
        await first.record('a', usage({ inputTokens: 10 }), 0.25, NOON);

        // A new instance stands in for the next window session.
        const second = new UsageHistory(store);
        await second.record('b', usage({ inputTokens: 10 }), undefined, NOON);

        expect(second.today(NOON)).toEqual({ cost: 0.75, requests: 3 });
    });

    it('keeps days apart and windows over them', async () => {
        const history = new UsageHistory(makeStore());
        await history.record('a', usage(), 1, NOON - 8 * DAY);
        await history.record('a', usage(), 2, NOON - 3 * DAY);
        await history.record('a', usage(), 4, NOON);

        expect(history.today(NOON)).toEqual({ cost: 4, requests: 1 });
        expect(history.window(7, NOON)).toEqual({ cost: 6, requests: 2 });
        expect(history.window(30, NOON)).toEqual({ cost: 7, requests: 3 });
    });

    it('prunes days past the retention window on write', async () => {
        const store = makeStore();
        const history = new UsageHistory(store);
        await history.record(
            'a',
            usage(),
            1,
            NOON - (USAGE_RETENTION_DAYS + 5) * DAY
        );
        await history.record('a', usage(), 1, NOON);

        const stored = store.read() as {
            days: Record<string, unknown>;
        };
        expect(Object.keys(stored.days)).toEqual([dayKeyOf(NOON)]);
    });

    it('reads a foreign stored shape as empty history', () => {
        for (const broken of [
            undefined,
            'text',
            { days: 'not-an-object' },
            { days: [1, 2] },
        ]) {
            const history = new UsageHistory(makeStore(broken));
            expect(history.today(NOON)).toEqual({ cost: 0, requests: 0 });
        }
    });

    it('survives a storage write that fails', async () => {
        const history = new UsageHistory({
            get: () => undefined,
            update: () => Promise.reject(new Error('disk full')),
        });

        await history.record('a', usage(), 1, NOON);
        expect(history.today(NOON)).toEqual({ cost: 1, requests: 1 });
    });
});

describe('dayKeyOf', () => {
    it('formats the local calendar day', () => {
        expect(dayKeyOf(new Date(2026, 8, 23, 0, 5).getTime())).toBe(
            '2026-09-23'
        );
        expect(dayKeyOf(new Date(2026, 0, 2, 23, 55).getTime())).toBe(
            '2026-01-02'
        );
    });
});
