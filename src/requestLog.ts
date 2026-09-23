/**
 * A bounded, persisted log of recently completed requests, behind the Recent
 * Requests view. One entry per completed request that carried a usage block;
 * a gateway that omits usage leaves no entry, matching what the tracker
 * books. Deliberately free of any `vscode` import, like usage.ts.
 */

/** The subset of `vscode.Memento` this module needs; see catalogCache.ts. */
type LogStore = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
};

export const REQUEST_LOG_KEY = 'tetrate-model-provider.requestLog';

/** Entries kept; enough to cover a working session without growing the blob. */
export const REQUEST_LOG_CAPACITY = 50;

export type RequestRecord = {
    /** Completion time, epoch ms. */
    at: number;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    /** Undefined when the model has no known price. */
    cost?: number;
    durationMs: number;
    /** Absent when the stream ended without producing output. */
    firstOutputMs?: number;
    /** The finish_reason of the last chunk that carried one. */
    finishReason?: string;
};

export class RequestLog {
    private items: RequestRecord[];
    private readonly listeners = new Set<() => void>();

    constructor(private readonly store?: LogStore) {
        this.items = readLog(store);
    }

    /** Newest first. */
    records(): readonly RequestRecord[] {
        return this.items;
    }

    add(record: RequestRecord): void {
        this.items = [record, ...this.items].slice(0, REQUEST_LOG_CAPACITY);
        // Storage is a nicety; losing a write must not fail the request.
        void this.store
            ?.update(REQUEST_LOG_KEY, this.items)
            ?.then(undefined, () => undefined);
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }
}

/** Anything persisted survives upgrades, so a foreign shape reads as empty. */
function readLog(store: LogStore | undefined): RequestRecord[] {
    const raw = store?.get<unknown>(REQUEST_LOG_KEY);
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .filter(
            (entry): entry is RequestRecord =>
                entry !== null &&
                typeof entry === 'object' &&
                typeof (entry as RequestRecord).at === 'number' &&
                typeof (entry as RequestRecord).modelId === 'string'
        )
        .slice(0, REQUEST_LOG_CAPACITY);
}
