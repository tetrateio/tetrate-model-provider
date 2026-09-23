import type { ProviderConfig } from './config';
import {
    describeGateway,
    describeProvider,
    type GatewayStatus,
    type ProviderReport,
} from './health';

/**
 * The connection status report behind the Show Connection Status command. It
 * exists to turn "no models in the picker" from a support thread into one
 * glance: which endpoint, whether a key is stored, whether that key reaches
 * the endpoint right now, and how old the catalog metadata is.
 */

export type ModelProbe = () => Promise<{ reachable: number; offered: number }>;

export type StatusInput = {
    version: string;
    config: ProviderConfig;
    keyStored: boolean;
    /** Absent when no key is stored; the probe would only report a 401. */
    probeModels: ModelProbe | undefined;
    catalog: { fetchedAt: number; entries: number } | undefined;
    /** The unauthenticated gateway status document, when it was fetched. */
    gateway?: GatewayStatus;
    /** Per-provider health from /v1/status, when the gateway serves it. */
    providerReport?: ProviderReport;
    now?: number;
};

export type StatusReport = {
    lines: string[];
    summary: string;
    healthy: boolean;
};

export async function buildStatusReport(
    input: StatusInput
): Promise<StatusReport> {
    const { config, keyStored, catalog } = input;
    const now = input.now ?? Date.now();

    let modelsLine: string;
    let summary: string;
    let healthy = false;

    if (!keyStored || !input.probeModels) {
        modelsLine = 'not checked, no API key is stored';
        summary =
            'No Agent Router API key is stored. Run "Set Agent Router API Key".';
    } else {
        try {
            const { reachable, offered } = await input.probeModels();
            modelsLine = `${reachable} model(s) reachable, ${offered} offered after filters`;
            summary = `Connected to ${config.baseUrl}: ${modelsLine}.`;
            healthy = offered > 0;
            if (offered === 0) {
                summary = `Connected to ${config.baseUrl}, but no models are offered. Check the model filter.`;
            }
        } catch (error) {
            modelsLine = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
            summary = `Could not list models at ${config.baseUrl}.`;
        }
    }

    const profile = Object.entries(config.profiles).find(
        ([, url]) => url === config.baseUrl
    )?.[0];

    // A gateway that reports itself down reframes every other line: the
    // docs' triage order is gateway first, then key, then request.
    if (input.gateway) {
        if (!input.gateway.reachable) {
            healthy = false;
            summary = `The gateway at ${config.baseUrl} is unreachable from this machine.`;
        } else if (input.gateway.status === 'not_serving') {
            healthy = false;
            summary = `The gateway reports it is not serving. This is not a problem with the API key.`;
        }
    }

    const lines = [
        `Extension version: ${input.version}`,
        `Base URL: ${config.baseUrl}${profile ? ` (profile: ${profile})` : ''}`,
        ...(input.gateway
            ? [`Gateway: ${describeGateway(input.gateway)}`]
            : []),
        ...(input.providerReport
            ? input.providerReport.providers.map(
                  (provider) =>
                      `Provider ${provider.name}: ${describeProvider(provider, now)}`
              )
            : []),
        `API key: ${keyStored ? 'stored in secret storage' : 'not stored'}`,
        `Models endpoint: ${modelsLine}`,
        `Public catalog: ${
            catalog
                ? `${catalog.entries} entries, refreshed ${formatAge(now - catalog.fetchedAt)} ago`
                : 'not cached yet'
        }`,
        `Model filter: ${describeCount(config.modelFilter.length, 'pattern')}`,
        `Model overrides: ${describeCount(Object.keys(config.modelOverrides).length, 'entry', 'entries')}`,
        `Request headers: ${describeCount(Object.keys(config.requestHeaders).length, 'header')}`,
    ];

    return { lines, summary, healthy };
}

function describeCount(
    count: number,
    singular: string,
    plural = `${singular}s`
): string {
    if (count === 0) {
        return '(none)';
    }
    return `${count} ${count === 1 ? singular : plural}`;
}

/** Coarse on purpose; "3 h" answers "is this stale" without inviting math. */
export function formatAge(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return 'less than a minute';
    }
    if (minutes < 60) {
        return `${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        return `${hours} h`;
    }
    return `${Math.floor(hours / 24)} d`;
}
