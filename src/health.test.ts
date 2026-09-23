import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    describeGateway,
    describeProvider,
    fetchGatewayStatus,
    fetchProviderReport,
} from './health';

afterEach(() => {
    vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('fetchGatewayStatus', () => {
    it('parses the status document when the gateway serves one', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    jsonResponse({
                        status: 'NOT_SERVING',
                        message: 'upgrade in progress',
                        data_plane: 'dp-1',
                    })
                )
            )
        );

        await expect(
            fetchGatewayStatus('https://gw.internal/v1')
        ).resolves.toEqual({
            reachable: true,
            status: 'not_serving',
            message: 'upgrade in progress',
            dataPlane: 'dp-1',
        });
    });

    it('asks the gateway origin, not the /v1 path', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(new Response('')));
        vi.stubGlobal('fetch', fetchMock);

        await fetchGatewayStatus('https://gw.internal:8443/proxy/v1');

        const [url] = fetchMock.mock.calls[0] as unknown as [string];
        expect(url).toBe('https://gw.internal:8443/');
    });

    it('treats an empty 200 as reachable with no status document', async () => {
        // The hosted service answers the root this way; it must not read as
        // an outage.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response('')))
        );

        await expect(
            fetchGatewayStatus('https://api.router.tetrate.ai/v1')
        ).resolves.toEqual({ reachable: true });
    });

    it('reports a non-2xx root as reachable but unknown', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response('teapot', { status: 418 })))
        );

        const status = await fetchGatewayStatus('https://gw.internal/v1');
        expect(status.reachable).toBe(true);
        expect(status.status).toBe('unknown');
    });

    it('reports a network failure as unreachable with the message', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('ENOTFOUND gw.internal')))
        );

        const status = await fetchGatewayStatus('https://gw.internal/v1');
        expect(status.reachable).toBe(false);
        expect(status.message).toContain('ENOTFOUND');
    });

    it('handles an unparseable base URL without throwing', async () => {
        const status = await fetchGatewayStatus('not a url');
        expect(status.reachable).toBe(false);
    });
});

describe('fetchProviderReport', () => {
    it('parses providers and sends the key', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(
                jsonResponse({
                    replica: 'replica-1',
                    observed_only: true,
                    providers: [
                        {
                            name: 'anthropic',
                            reachable: true,
                            observed_requests: 12,
                            failures: 0,
                        },
                        {
                            name: 'openai',
                            reachable: false,
                            observed_requests: 3,
                            failures: 3,
                            last_failure_at: '2026-09-23T12:00:00Z',
                            last_failure_code: 529,
                        },
                        { name: 'quiet', reachable: null },
                        { notAName: true },
                    ],
                })
            )
        );
        vi.stubGlobal('fetch', fetchMock);

        const report = await fetchProviderReport('https://gw/v1', 'sk-k', {
            'X-Tenant-Id': 'team',
        });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe('https://gw/v1/status');
        expect(init.headers).toMatchObject({
            Authorization: 'Bearer sk-k',
            'X-Tenant-Id': 'team',
        });
        expect(report?.replica).toBe('replica-1');
        expect(report?.providers).toHaveLength(3);
        expect(report?.providers[1]).toMatchObject({
            name: 'openai',
            reachable: false,
            lastFailureCode: '529',
        });
        expect(report?.providers[2]?.reachable).toBeNull();
    });

    it('returns undefined for a gateway that does not serve the route', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(new Response('not found', { status: 404 }))
            )
        );
        await expect(
            fetchProviderReport('https://gw/v1', 'sk-k', {})
        ).resolves.toBeUndefined();
    });

    it('returns undefined on a network failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('ECONNRESET')))
        );
        await expect(
            fetchProviderReport('https://gw/v1', 'sk-k', {})
        ).resolves.toBeUndefined();
    });
});

describe('describeGateway', () => {
    it('phrases each state', () => {
        expect(describeGateway({ reachable: false, message: 'down' })).toBe(
            'unreachable — down'
        );
        expect(
            describeGateway({
                reachable: true,
                status: 'serving',
                dataPlane: 'dp-1',
            })
        ).toBe('serving (dp-1)');
        expect(
            describeGateway({
                reachable: true,
                status: 'not_serving',
                message: 'upgrade',
            })
        ).toBe('NOT SERVING — upgrade');
        expect(describeGateway({ reachable: true })).toBe(
            'reachable (no status document)'
        );
    });
});

describe('describeProvider', () => {
    const NOW = Date.parse('2026-09-23T12:05:00Z');

    it('phrases healthy, failing, and quiet providers', () => {
        expect(
            describeProvider(
                {
                    name: 'a',
                    reachable: true,
                    observedRequests: 12,
                    failures: 0,
                },
                NOW
            )
        ).toBe('healthy · 12 request(s) observed');
        expect(
            describeProvider(
                {
                    name: 'b',
                    reachable: false,
                    observedRequests: 3,
                    failures: 3,
                    lastFailureAt: '2026-09-23T12:00:00Z',
                    lastFailureCode: '529',
                },
                NOW
            )
        ).toBe('failing (529) · 3 failure(s), last 5 min ago');
        expect(
            describeProvider(
                { name: 'c', reachable: null, observedRequests: 0, failures: 0 },
                NOW
            )
        ).toBe('no traffic observed');
    });
});
