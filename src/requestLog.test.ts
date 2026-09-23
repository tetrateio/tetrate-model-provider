import { describe, expect, it, vi } from 'vitest';

import {
    REQUEST_LOG_CAPACITY,
    REQUEST_LOG_KEY,
    RequestLog,
    type RequestRecord,
} from './requestLog';

function record(partial: Partial<RequestRecord> = {}): RequestRecord {
    return {
        at: 1_800_000_000_000,
        modelId: 'claude-test',
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 1200,
        ...partial,
    };
}

function makeStore(initial?: unknown) {
    let value = initial;
    return {
        get<T>(key: string): T | undefined {
            return key === REQUEST_LOG_KEY ? (value as T) : undefined;
        },
        update(key: string, next: unknown) {
            if (key === REQUEST_LOG_KEY) {
                value = next;
            }
            return Promise.resolve();
        },
        read: () => value,
    };
}

describe('RequestLog', () => {
    it('keeps records newest first and persists them', () => {
        const store = makeStore();
        const log = new RequestLog(store);
        log.add(record({ modelId: 'first' }));
        log.add(record({ modelId: 'second' }));

        expect(log.records().map((r) => r.modelId)).toEqual([
            'second',
            'first',
        ]);
        const reloaded = new RequestLog(store);
        expect(reloaded.records()).toHaveLength(2);
    });

    it('is bounded at the capacity', () => {
        const log = new RequestLog();
        for (let i = 0; i < REQUEST_LOG_CAPACITY + 10; i++) {
            log.add(record({ inputTokens: i }));
        }
        expect(log.records()).toHaveLength(REQUEST_LOG_CAPACITY);
        expect(log.records()[0]?.inputTokens).toBe(REQUEST_LOG_CAPACITY + 9);
    });

    it('notifies on every addition until disposed', () => {
        const log = new RequestLog();
        const listener = vi.fn();
        const subscription = log.onDidChange(listener);

        log.add(record());
        expect(listener).toHaveBeenCalledTimes(1);

        subscription.dispose();
        log.add(record());
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reads a foreign stored shape as empty', () => {
        for (const broken of ['text', { items: [] }, [{ nope: true }], null]) {
            expect(new RequestLog(makeStore(broken)).records()).toEqual([]);
        }
    });

    it('survives a storage write that fails', () => {
        const log = new RequestLog({
            get: () => undefined,
            update: () => Promise.reject(new Error('disk full')),
        });
        log.add(record());
        expect(log.records()).toHaveLength(1);
    });
});
