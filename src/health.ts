import { formatAge } from './diagnostics';

/**
 * The gateway's two health surfaces, per the Agent Router docs' outage
 * triage: the unauthenticated status document at the gateway root, and the
 * authenticated per-provider report at /v1/status. Both are answered by the
 * data plane, so they work through a management-plane outage; both are
 * best-effort here, because health display must never break the extension.
 *
 * The hosted service answers the root with an empty 200 rather than the
 * documented JSON status document (an Enterprise data-plane feature), so
 * "reachable with no status document" is a first-class state, not an error.
 */

export const HEALTH_TIMEOUT_MS = 8_000;

export type GatewayStatus = {
    /** The host answered HTTP at all; false is a network-level failure. */
    reachable: boolean;
    /** From the status document, when one is served: serving | not_serving | unknown. */
    status?: string;
    message?: string;
    dataPlane?: string;
};

/** One provider's health over the gateway's sliding observation window. */
export type ProviderHealth = {
    name: string;
    /** true = healthy, false = failing, null = no traffic observed. */
    reachable: boolean | null;
    observedRequests: number;
    failures: number;
    lastFailureAt?: string;
    lastFailureCode?: string;
};

export type ProviderReport = {
    replica?: string;
    providers: ProviderHealth[];
};

/** GET on the gateway origin; unauthenticated by design. */
export async function fetchGatewayStatus(
    baseUrl: string
): Promise<GatewayStatus> {
    let origin: string;
    try {
        origin = new URL(baseUrl).origin;
    } catch {
        return { reachable: false, message: `Invalid base URL: ${baseUrl}` };
    }

    let response: Response;
    try {
        response = await get(`${origin}/`);
    } catch (error) {
        return {
            reachable: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const body = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(body) as {
            status?: string;
            message?: string;
            data_plane?: string;
        };
        if (parsed && typeof parsed.status === 'string') {
            return {
                reachable: true,
                status: parsed.status.toLowerCase(),
                ...(parsed.message ? { message: parsed.message } : {}),
                ...(parsed.data_plane ? { dataPlane: parsed.data_plane } : {}),
            };
        }
    } catch {
        // Not a status document; reachability is still the answer.
    }
    return response.ok
        ? { reachable: true }
        : {
              reachable: true,
              status: 'unknown',
              message: `HTTP ${response.status} from the gateway root`,
          };
}

/**
 * GET {baseUrl}/status with the inference key. Undefined when the endpoint
 * is missing, unauthorized, or unreachable: older data planes do not serve
 * it, and its absence must not read as an outage.
 */
export async function fetchProviderReport(
    baseUrl: string,
    apiKey: string,
    headers: Record<string, string>
): Promise<ProviderReport | undefined> {
    let response: Response;
    try {
        response = await get(`${baseUrl}/status`, {
            ...headers,
            Authorization: `Bearer ${apiKey}`,
        });
    } catch {
        return undefined;
    }
    if (!response.ok) {
        return undefined;
    }

    try {
        const body = (await response.json()) as {
            replica?: string;
            providers?: Array<{
                name?: string;
                reachable?: boolean | null;
                observed_requests?: number;
                failures?: number;
                last_failure_at?: string;
                last_failure_code?: string | number;
            }>;
        };
        return {
            ...(body.replica ? { replica: body.replica } : {}),
            providers: (body.providers ?? [])
                .filter((entry) => typeof entry?.name === 'string')
                .map((entry) => ({
                    name: entry.name as string,
                    reachable: entry.reachable ?? null,
                    observedRequests: entry.observed_requests ?? 0,
                    failures: entry.failures ?? 0,
                    ...(entry.last_failure_at
                        ? { lastFailureAt: entry.last_failure_at }
                        : {}),
                    ...(entry.last_failure_code !== undefined
                        ? { lastFailureCode: String(entry.last_failure_code) }
                        : {}),
                })),
        };
    } catch {
        return undefined;
    }
}

/** One phrase for the gateway row and the status report line. */
export function describeGateway(status: GatewayStatus): string {
    if (!status.reachable) {
        return `unreachable${status.message ? ` — ${status.message}` : ''}`;
    }
    if (status.status === 'serving') {
        return `serving${status.dataPlane ? ` (${status.dataPlane})` : ''}`;
    }
    if (status.status === 'not_serving') {
        // The document's own message says the key is not the problem, which
        // is the entire point of surfacing it.
        return `NOT SERVING${status.message ? ` — ${status.message}` : ''}`;
    }
    if (status.status === 'unknown') {
        return `status unknown${status.message ? ` — ${status.message}` : ''}`;
    }
    return 'reachable (no status document)';
}

/**
 * One phrase per provider. `reachable: null` means no traffic in the
 * observation window — explicitly not the same as healthy, per the docs.
 */
export function describeProvider(
    health: ProviderHealth,
    now: number = Date.now()
): string {
    if (health.reachable === true) {
        return `healthy · ${health.observedRequests} request(s) observed`;
    }
    if (health.reachable === false) {
        const code = health.lastFailureCode
            ? ` (${health.lastFailureCode})`
            : '';
        const at = health.lastFailureAt
            ? Date.parse(health.lastFailureAt)
            : NaN;
        const age = Number.isFinite(at)
            ? `, last ${formatAge(now - at)} ago`
            : '';
        return `failing${code} · ${health.failures} failure(s)${age}`;
    }
    return 'no traffic observed';
}

async function get(
    url: string,
    headers: Record<string, string> = {}
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}
