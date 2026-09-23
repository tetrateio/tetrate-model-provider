import type { RequestUsage } from './usage';

/**
 * Durable usage aggregates behind the session tracker. Session totals reset
 * on every reload, which makes them a curiosity; the daily aggregates stored
 * here survive reloads and feed the today and last-seven-days figures in the
 * usage report, and the daily spend warning.
 *
 * Counts are approximate by design. The store is loaded once per window and
 * written back after each request, so two windows recording at the same time
 * overwrite each other's increments. Billing truth stays with the Agent
 * Router dashboard; this exists to answer "roughly what has today cost".
 */

/** The subset of `vscode.Memento` this module needs; see catalogCache.ts. */
type HistoryStore = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
};

export const USAGE_HISTORY_KEY = 'tetrate-model-provider.usageHistory';

/** Days kept before a day's aggregates are pruned on the next write. */
export const USAGE_RETENTION_DAYS = 62;

export type StoredTotals = RequestUsage & {
    requests: number;
    cost: number;
    unpricedRequests: number;
};

type StoredHistory = {
    /** Keyed by local day (`2026-09-23`), then by model id. */
    days: Record<string, Record<string, StoredTotals>>;
};

export class UsageHistory {
    /** In-memory truth for this window; the store is write-through. */
    private readonly history: StoredHistory;

    constructor(private readonly store: HistoryStore) {
        this.history = readHistory(store);
    }

    /** Books one request under today and persists. */
    async record(
        modelId: string,
        usage: RequestUsage,
        cost: number | undefined,
        now: number = Date.now()
    ): Promise<void> {
        const day = dayKeyOf(now);
        const models = (this.history.days[day] ??= {});
        const totals = (models[modelId] ??= {
            requests: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cost: 0,
            unpricedRequests: 0,
        });
        totals.requests += 1;
        totals.inputTokens += usage.inputTokens;
        totals.cachedInputTokens += usage.cachedInputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.reasoningTokens += usage.reasoningTokens;
        totals.cost += cost ?? 0;
        totals.unpricedRequests += cost === undefined ? 1 : 0;

        this.prune(now);
        try {
            await this.store.update(USAGE_HISTORY_KEY, this.history);
        } catch {
            // Storage is a nicety; losing a write must not fail the request.
        }
    }

    /** Cost and request count booked under today. */
    today(now: number = Date.now()): { cost: number; requests: number } {
        return this.window(1, now);
    }

    /** Cost and request count over the last `days` local days, today included. */
    window(
        days: number,
        now: number = Date.now()
    ): { cost: number; requests: number } {
        let cost = 0;
        let requests = 0;
        for (const day of lastDays(days, now)) {
            for (const totals of Object.values(this.history.days[day] ?? {})) {
                cost += totals.cost;
                requests += totals.requests;
            }
        }
        return { cost, requests };
    }

    private prune(now: number): void {
        const keep = new Set(lastDays(USAGE_RETENTION_DAYS, now));
        for (const day of Object.keys(this.history.days)) {
            if (!keep.has(day)) {
                delete this.history.days[day];
            }
        }
    }
}

/**
 * The local calendar day, since "today's spend" means the user's today. A
 * timezone change mid-day splits a day; that is acceptable imprecision.
 */
export function dayKeyOf(now: number): string {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function lastDays(days: number, now: number): string[] {
    return Array.from({ length: Math.max(1, days) }, (_, i) =>
        dayKeyOf(now - i * 24 * 60 * 60 * 1000)
    );
}

/** Anything persisted survives upgrades, so a foreign shape reads as empty. */
function readHistory(store: HistoryStore): StoredHistory {
    const raw = store.get<StoredHistory>(USAGE_HISTORY_KEY);
    if (
        !raw ||
        typeof raw !== 'object' ||
        raw.days === null ||
        typeof raw.days !== 'object' ||
        Array.isArray(raw.days)
    ) {
        return { days: {} };
    }
    return { days: raw.days };
}
