import { describe, expect, it } from 'vitest';

import type { ProviderConfig } from './config';
import { buildStatusReport, formatAge, type StatusInput } from './diagnostics';

const config: ProviderConfig = {
    baseUrl: 'https://api.router.tetrate.ai/v1',
    modelFilter: [],
    requestHeaders: {},
    modelOverrides: {},
    profiles: {},
    spendWarning: 0,
};

const base: StatusInput = {
    version: '0.5.0',
    config,
    keyStored: true,
    probeModels: () => Promise.resolve({ reachable: 163, offered: 12 }),
    catalog: { fetchedAt: 0, entries: 210 },
    now: 3 * 60 * 60 * 1000,
};

describe('buildStatusReport', () => {
    it('reports a healthy connection with counts and catalog age', async () => {
        const report = await buildStatusReport(base);

        expect(report.healthy).toBe(true);
        expect(report.summary).toContain('163 model(s) reachable');
        expect(report.lines).toEqual([
            'Extension version: 0.5.0',
            'Base URL: https://api.router.tetrate.ai/v1',
            'API key: stored in secret storage',
            'Models endpoint: 163 model(s) reachable, 12 offered after filters',
            'Public catalog: 210 entries, refreshed 3 h ago',
            'Model filter: (none)',
            'Model overrides: (none)',
            'Request headers: (none)',
        ]);
    });

    it('skips the probe and points at the key command when no key is stored', async () => {
        const report = await buildStatusReport({
            ...base,
            keyStored: false,
            probeModels: undefined,
        });

        expect(report.healthy).toBe(false);
        expect(report.summary).toContain('Set Agent Router API Key');
        expect(report.lines[3]).toContain('no API key is stored');
    });

    it('surfaces a probe failure with its message', async () => {
        const report = await buildStatusReport({
            ...base,
            probeModels: () => Promise.reject(new Error('HTTP 401: bad key')),
        });

        expect(report.healthy).toBe(false);
        expect(report.summary).toContain('Could not list models');
        expect(report.lines[3]).toContain('HTTP 401: bad key');
    });

    it('flags a connection that offers no models as unhealthy', async () => {
        const report = await buildStatusReport({
            ...base,
            config: { ...config, modelFilter: ['no-such-*'] },
            probeModels: () => Promise.resolve({ reachable: 163, offered: 0 }),
        });

        expect(report.healthy).toBe(false);
        expect(report.summary).toContain('no models are offered');
        expect(report.lines[5]).toBe('Model filter: 1 pattern');
    });

    it('reports the gateway status and per-provider health when supplied', async () => {
        const report = await buildStatusReport({
            ...base,
            gateway: { reachable: true, status: 'serving', dataPlane: 'dp-1' },
            providerReport: {
                providers: [
                    {
                        name: 'anthropic',
                        reachable: true,
                        observedRequests: 12,
                        failures: 0,
                    },
                    {
                        name: 'openai',
                        reachable: false,
                        observedRequests: 3,
                        failures: 3,
                        lastFailureCode: '529',
                    },
                ],
            },
        });

        expect(report.healthy).toBe(true);
        expect(report.lines).toContain('Gateway: serving (dp-1)');
        expect(report.lines).toContain(
            'Provider anthropic: healthy · 12 request(s) observed'
        );
        expect(
            report.lines.some((line) =>
                line.startsWith('Provider openai: failing (529)')
            )
        ).toBe(true);
    });

    it('lets a not-serving gateway override an otherwise healthy report', async () => {
        const report = await buildStatusReport({
            ...base,
            gateway: {
                reachable: true,
                status: 'not_serving',
                message: 'upgrade in progress',
            },
        });

        expect(report.healthy).toBe(false);
        expect(report.summary).toContain('not serving');
        expect(report.summary).toContain('not a problem with the API key');
    });

    it('reports an unreachable gateway as the headline', async () => {
        const report = await buildStatusReport({
            ...base,
            gateway: { reachable: false, message: 'ENOTFOUND' },
        });

        expect(report.healthy).toBe(false);
        expect(report.summary).toContain('unreachable');
    });

    it('reports a missing catalog cache as such', async () => {
        const report = await buildStatusReport({ ...base, catalog: undefined });
        expect(report.lines[4]).toBe('Public catalog: not cached yet');
    });

    it('names the profile the base URL matches', async () => {
        const report = await buildStatusReport({
            ...base,
            config: {
                ...config,
                profiles: {
                    Production: config.baseUrl,
                    Staging: 'https://staging.internal/v1',
                },
            },
        });
        expect(report.lines[1]).toBe(
            `Base URL: ${config.baseUrl} (profile: Production)`
        );
    });

    it('counts overrides and headers', async () => {
        const report = await buildStatusReport({
            ...base,
            config: {
                ...config,
                modelOverrides: { 'claude-*': { temperature: 0.2 } },
                requestHeaders: { 'X-Tenant-Id': 'a', 'X-Region': 'b' },
            },
        });
        expect(report.lines[6]).toBe('Model overrides: 1 entry');
        expect(report.lines[7]).toBe('Request headers: 2 headers');
    });
});

describe('formatAge', () => {
    it('rounds to the most useful unit', () => {
        expect(formatAge(30_000)).toBe('less than a minute');
        expect(formatAge(5 * 60_000)).toBe('5 min');
        expect(formatAge(3 * 60 * 60_000)).toBe('3 h');
        expect(formatAge(72 * 60 * 60_000)).toBe('3 d');
    });
});
