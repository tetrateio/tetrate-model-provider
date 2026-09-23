import type { ModelPricing } from './catalog';

/**
 * Session-scoped usage accounting.
 *
 * Token counts come from the `usage` block the endpoint attaches to the final
 * stream chunk when asked, so they are the billed numbers, not the local
 * estimates from tokenCount.ts. Costs are computed from the public catalog's
 * per-million prices; a request whose model has no known price is still
 * counted, and its absence is reported rather than silently priced at zero.
 *
 * Deliberately free of any `vscode` import so it stays trivially testable;
 * the extension wires `subscribe` to the status bar.
 */

/** The billed token counts of one completed request. */
export type RequestUsage = {
    inputTokens: number;
    /** Portion of inputTokens served from the provider's prompt cache. */
    cachedInputTokens: number;
    outputTokens: number;
    /** Portion of outputTokens spent thinking; informational. */
    reasoningTokens: number;
};

/**
 * Dollar cost of one request, or undefined when the price is unknown. Cached
 * input is billed at the cache rate where the catalog states one, and at the
 * full input rate otherwise, which errs toward overstating cost.
 */
export function costOf(
    usage: RequestUsage,
    pricing: ModelPricing | undefined
): number | undefined {
    if (!pricing) {
        return undefined;
    }
    const cached = Math.min(
        Math.max(usage.cachedInputTokens, 0),
        Math.max(usage.inputTokens, 0)
    );
    const uncached = Math.max(usage.inputTokens, 0) - cached;
    const cachedRate = pricing.cachedPer1M ?? pricing.inputPer1M;
    return (
        (uncached * pricing.inputPer1M +
            cached * cachedRate +
            Math.max(usage.outputTokens, 0) * pricing.outputPer1M) /
        1_000_000
    );
}

type ModelTotals = RequestUsage & {
    requests: number;
    cost: number;
    unpricedRequests: number;
};

/** What subscribers receive for each completed request. */
export type UsageEvent = {
    modelId: string;
    usage: RequestUsage;
    /** Undefined when the model has no known price. */
    cost: number | undefined;
};

export class UsageTracker {
    private readonly byModel = new Map<string, ModelTotals>();
    private readonly listeners = new Set<(event: UsageEvent) => void>();

    /** Adds one request and returns its cost, when the price is known. */
    record(
        modelId: string,
        usage: RequestUsage,
        pricing: ModelPricing | undefined
    ): number | undefined {
        const cost = costOf(usage, pricing);
        const totals = this.byModel.get(modelId) ?? {
            requests: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cost: 0,
            unpricedRequests: 0,
        };
        totals.requests += 1;
        totals.inputTokens += usage.inputTokens;
        totals.cachedInputTokens += usage.cachedInputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.reasoningTokens += usage.reasoningTokens;
        totals.cost += cost ?? 0;
        totals.unpricedRequests += cost === undefined ? 1 : 0;
        this.byModel.set(modelId, totals);

        for (const listener of [...this.listeners]) {
            listener({ modelId, usage, cost });
        }
        return cost;
    }

    /** Notifies after every recorded request; returns a disposable. */
    subscribe(listener: (event: UsageEvent) => void): { dispose(): void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    get requestCount(): number {
        return sum(this.byModel, (totals) => totals.requests);
    }

    get totalTokens(): number {
        return sum(
            this.byModel,
            (totals) => totals.inputTokens + totals.outputTokens
        );
    }

    get totalCost(): number {
        return sum(this.byModel, (totals) => totals.cost);
    }

    /** True when at least one request could not be priced. */
    get hasUnpricedRequests(): boolean {
        return [...this.byModel.values()].some(
            (totals) => totals.unpricedRequests > 0
        );
    }

    /**
     * The short figure for the status bar: the session cost when any request
     * was priced, the token count otherwise, with `+` marking a total that
     * excludes unpriced requests.
     */
    headline(): string {
        if (this.requestCount === 0) {
            return 'no requests';
        }
        if (this.totalCost > 0 || !this.hasUnpricedRequests) {
            return `${formatCost(this.totalCost)}${this.hasUnpricedRequests ? '+' : ''}`;
        }
        return `${formatTokens(this.totalTokens)} tokens`;
    }

    /** One line per model, biggest spender first, plus a session total. */
    summarize(): string[] {
        const lines = [...this.byModel.entries()]
            .sort(
                ([, a], [, b]) =>
                    b.cost - a.cost ||
                    b.inputTokens +
                        b.outputTokens -
                        (a.inputTokens + a.outputTokens)
            )
            .map(([modelId, totals]) => describeTotals(modelId, totals));

        const total = `Session total: ${this.requestCount} request(s), ${formatTokens(this.totalTokens)} tokens, ${formatCost(this.totalCost)}${
            this.hasUnpricedRequests
                ? ' (some requests have no known price)'
                : ''
        }`;
        return [...lines, total];
    }
}

function describeTotals(modelId: string, totals: ModelTotals): string {
    const cached =
        totals.cachedInputTokens > 0
            ? ` (${formatTokens(totals.cachedInputTokens)} cached)`
            : '';
    const reasoning =
        totals.reasoningTokens > 0
            ? ` incl. ${formatTokens(totals.reasoningTokens)} reasoning`
            : '';
    const price =
        totals.unpricedRequests === totals.requests
            ? 'price unknown'
            : formatCost(totals.cost);
    return `${modelId}: ${totals.requests} request(s), ${formatTokens(totals.inputTokens)} in${cached} + ${formatTokens(totals.outputTokens)} out${reasoning}, ${price}`;
}

/**
 * Small sums need the extra digits: a cheap model's request costs a fraction
 * of a cent, and `$0.00` would suggest the tracking is broken.
 */
export function formatCost(cost: number): string {
    if (cost > 0 && cost < 0.0001) {
        return '<$0.0001';
    }
    return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
}

/** Fixed locale, so tests and log lines do not vary by machine. */
export function formatTokens(count: number): string {
    return count.toLocaleString('en-US');
}

function sum(
    byModel: Map<string, ModelTotals>,
    field: (totals: ModelTotals) => number
): number {
    let total = 0;
    for (const totals of byModel.values()) {
        total += field(totals);
    }
    return total;
}
