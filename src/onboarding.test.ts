import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROBE_TIMEOUT_MS, probeCompletion } from './onboarding';

const options = {
    baseUrl: 'https://x/v1',
    apiKey: 'secret',
    headers: { 'X-Tenant-Id': 'team' },
    modelId: 'claude-opus-5',
};

/** A server that accepts the connection and then says nothing. */
function hangingFetch() {
    return vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () =>
                    reject((init.signal as AbortSignal).reason)
                );
            })
    );
}

describe('probeCompletion', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('reports ok with the elapsed time on a 2xx', async () => {
        const fetchMock = vi.fn(async () => {
            await vi.advanceTimersByTimeAsync(120);
            return new Response('{}', { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(probeCompletion(options)).resolves.toEqual({
            ok: true,
            modelId: 'claude-opus-5',
            ms: 120,
        });
    });

    it('sends the completion request with the key and the extra headers', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response('{}', { status: 200 }))
        );
        vi.stubGlobal('fetch', fetchMock);

        await probeCompletion(options);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe('https://x/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'Bearer secret',
            'X-Tenant-Id': 'team',
        });
        expect(JSON.parse(init.body as string)).toEqual({
            model: 'claude-opus-5',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
        });
    });

    it('reports the status and body on a non-2xx', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response('  {"error": "invalid api key"}  ', {
                        status: 401,
                        statusText: 'Unauthorized',
                    })
                )
            )
        );

        const result = await probeCompletion(options);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('HTTP 401 Unauthorized');
            expect(result.message).toContain('invalid api key');
        }
    });

    it('tolerates a body that cannot be read', async () => {
        // Response.text is read-only, so the failing read needs a structural
        // fake rather than a patched real Response.
        const response = {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: () => Promise.reject(new Error('connection reset')),
        } as unknown as Response;
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)));

        await expect(probeCompletion(options)).resolves.toEqual({
            ok: false,
            message: 'HTTP 502 Bad Gateway',
        });
    });

    it('reports a network failure as its message', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('fetch failed')))
        );

        await expect(probeCompletion(options)).resolves.toEqual({
            ok: false,
            message: 'fetch failed',
        });
    });

    it('gives up after the timeout and names the allowance', async () => {
        vi.stubGlobal('fetch', hangingFetch());

        const pending = probeCompletion(options);
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain(`${PROBE_TIMEOUT_MS} ms`);
        }
    });
});
