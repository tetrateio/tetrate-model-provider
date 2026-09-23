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

export type ModelTotals = RequestUsage & {
    requests: number;
    cost: number;
    unpricedRequests: number;
};

/** Timing and outcome of one request, alongside its token counts. */
export type RequestMeta = {
    durationMs: number;
    /** Absent when the stream ended without producing output. */
    firstOutputMs?: number;
    finishReason?: string;
    /** The X-Request-ID sent with the request; the Request Logs search key. */
    requestId?: string;
    /**
     * The backend that actually answered, when it differs from the requested
     * id: the response's own `model` field names it under fallback routing or
     * a model-name override.
     */
    servedBy?: string;
};

/** What subscribers receive for each completed request. */
export type UsageEvent = {
    modelId: string;
    usage: RequestUsage;
    /** Undefined when the model has no known price. */
    cost: number | undefined;
    meta?: RequestMeta;
};

/**
 * Recent first-output samples kept per model. Enough for a stable median,
 * small enough that a long session cannot grow the tracker unbounded.
 */
const FIRST_OUTPUT_SAMPLE_LIMIT = 50;

export class UsageTracker {
    private readonly byModel = new Map<string, ModelTotals>();
    private readonly firstOutputByModel = new Map<string, number[]>();
    private readonly listeners = new Set<(event: UsageEvent) => void>();

    /** Adds one request and returns its cost, when the price is known. */
    record(
        modelId: string,
        usage: RequestUsage,
        pricing: ModelPricing | undefined,
        meta?: RequestMeta
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

        if (meta?.firstOutputMs !== undefined) {
            const samples = this.firstOutputByModel.get(modelId) ?? [];
            samples.push(meta.firstOutputMs);
            this.firstOutputByModel.set(
                modelId,
                samples.slice(-FIRST_OUTPUT_SAMPLE_LIMIT)
            );
        }

        for (const listener of [...this.listeners]) {
            listener({ modelId, usage, cost, ...(meta ? { meta } : {}) });
        }
        return cost;
    }

    /**
     * Median time to first output over recent requests, or undefined when no
     * request for the model has produced output yet.
     */
    firstOutputStats(
        modelId: string
    ): { medianMs: number; samples: number } | undefined {
        const samples = this.firstOutputByModel.get(modelId);
        if (!samples || samples.length === 0) {
            return undefined;
        }
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        // The fallbacks satisfy noUncheckedIndexedAccess; the non-empty check
        // above means they can never be taken.
        const upper = sorted[mid] ?? 0;
        const medianMs =
            sorted.length % 2 === 1
                ? upper
                : ((sorted[mid - 1] ?? 0) + upper) / 2;
        return { medianMs, samples: samples.length };
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

    /** Per-model totals, biggest spender first, for tooltips and dashboards. */
    perModel(): Array<ModelTotals & { modelId: string }> {
        return [...this.byModel.entries()]
            .sort(
                ([, a], [, b]) =>
                    b.cost - a.cost ||
                    b.inputTokens +
                        b.outputTokens -
                        (a.inputTokens + a.outputTokens)
            )
            .map(([modelId, totals]) => ({ modelId, ...totals }));
    }

    /** One line per model, biggest spender first, plus a session total. */
    summarize(): string[] {
        const lines = this.perModel().map(({ modelId, ...totals }) =>
            describeTotals(modelId, totals)
        );

        const total = `Session total: ${this.requestCount} request(s), ${formatTokens(this.totalTokens)} tokens, ${formatCost(this.totalCost)}${
            this.hasUnpricedRequests
                ? ' (some requests have no known price)'
                : ''
        }`;
        return [...lines, total];
    }
}

/** One request currently being answered. */
export type ActiveRequest = {
    modelId: string;
    startedAt: number;
    outputStarted: boolean;
};

/**
 * Tracks requests between dispatch and completion, for surfacing in-flight
 * work in the UI. Handles rather than objects, so a provider's finally block
 * can end a request without holding a reference across the whole stream.
 */
export class ActivityTracker {
    private readonly byHandle = new Map<number, ActiveRequest>();
    private readonly listeners = new Set<() => void>();
    private nextHandle = 1;

    /** Registers a request; returns a handle to mark and end it with. */
    begin(modelId: string, startedAt = Date.now()): number {
        const handle = this.nextHandle++;
        this.byHandle.set(handle, {
            modelId,
            startedAt,
            outputStarted: false,
        });
        this.notify();
        return handle;
    }

    /** Marks the first output; repeated and unknown handles are ignored. */
    markOutput(handle: number): void {
        const request = this.byHandle.get(handle);
        if (!request || request.outputStarted) {
            return;
        }
        request.outputStarted = true;
        this.notify();
    }

    /** Removes the request; unknown handles are ignored. */
    end(handle: number): void {
        if (this.byHandle.delete(handle)) {
            this.notify();
        }
    }

    /** In-flight requests, oldest first. Copies, so a snapshot a subscriber
     * takes is not mutated underfoot by a later markOutput. */
    get active(): readonly ActiveRequest[] {
        return [...this.byHandle.values()].map((request) => ({ ...request }));
    }

    /** Notifies on begin, first output, and end; returns a disposable. */
    subscribe(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
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
