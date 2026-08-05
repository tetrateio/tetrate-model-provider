import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import {
    type ApiModel,
    CATALOG_TIMEOUT_MS,
    type CatalogModel,
    MODELS_TIMEOUT_MS,
    FALLBACK_CONTEXT_WINDOW,
    FALLBACK_MAX_OUTPUT_TOKENS,
    familyOf,
    fetchApiModels,
    fetchPublicCatalogModels,
    isChatModel,
    MIN_INPUT_TOKENS,
    MODELS_ATTEMPTS,
    RequestTimeoutError,
    selectChatModels,
    toChatInformation,
    versionOf,
} from './catalog';

const opus: CatalogModel = {
    model: 'claude-opus-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5',
    mode: 'chat',
    contextWindow: 1_000_000,
    capabilities: ['tool_choice', 'vision', 'reasoning'],
    modalities: { input: ['document', 'image', 'text'], output: ['text'] },
    limits: { max_output_tokens: 128_000 },
    metadata: { description: 'For complex agentic coding.' },
};

describe('toChatInformation', () => {
    it('uses catalog metadata and reserves the output budget', () => {
        const info = toChatInformation({ id: 'claude-opus-5' }, opus);

        expect(info).toMatchObject({
            id: 'claude-opus-5',
            name: 'Claude Opus 5',
            family: 'anthropic',
            version: '5.0',
            maxOutputTokens: 128_000,
            detail: 'Agent Router · anthropic',
            tooltip: 'For complex agentic coding.',
        });
        expect(info.maxInputTokens).toBe(1_000_000 - 128_000);
        expect(info.capabilities).toEqual({
            toolCalling: true,
            imageInput: true,
        });
    });

    it('falls back to conservative limits without catalog data', () => {
        const info = toChatInformation({ id: 'mystery-model' }, undefined);

        expect(info.name).toBe('mystery-model');
        expect(info.maxOutputTokens).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
        expect(info.maxInputTokens).toBe(
            FALLBACK_CONTEXT_WINDOW - FALLBACK_MAX_OUTPUT_TOKENS
        );
        // An unknown model is assumed capable rather than crippled, since the
        // catalog simply may not describe it.
        expect(info.capabilities.toolCalling).toBe(true);
    });

    it('reports no image support when the catalog omits vision', () => {
        const info = toChatInformation(
            { id: 'text-only' },
            { model: 'text-only', mode: 'chat', capabilities: ['tool_choice'] }
        );
        expect(info.capabilities.imageInput).toBe(false);
    });

    it('keeps a known context window when the output limit is missing', () => {
        // Common in the live catalog: the xai models report contextWindow but
        // no limits.max_output_tokens.
        const info = toChatInformation(
            { id: 'xai/grok-4.5' },
            {
                model: 'xai/grok-4.5',
                provider: 'xai',
                mode: 'chat',
                contextWindow: 2_000_000,
                capabilities: ['tool_choice', 'vision'],
            }
        );

        expect(info.maxOutputTokens).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
        expect(info.maxInputTokens).toBe(
            2_000_000 - FALLBACK_MAX_OUTPUT_TOKENS
        );
    });

    it('never leaves the input budget non-positive', () => {
        const info = toChatInformation(
            { id: 'tiny' },
            {
                model: 'tiny',
                mode: 'chat',
                contextWindow: 4096,
                limits: { max_output_tokens: 8192 },
            }
        );
        expect(info.maxInputTokens).toBeGreaterThan(0);
    });

    it('keeps the two budgets inside the context window', () => {
        // A model advertising an output cap as large as its whole window would
        // otherwise be reported as input floor *plus* full output, which
        // overcommits the window and fails at request time.
        const info = toChatInformation(
            { id: 'snug' },
            {
                model: 'snug',
                mode: 'chat',
                contextWindow: 8192,
                limits: { max_output_tokens: 8192 },
            }
        );

        expect(info.maxInputTokens).toBe(MIN_INPUT_TOKENS);
        expect(info.maxOutputTokens).toBe(8192 - MIN_INPUT_TOKENS);
        expect(info.maxInputTokens + info.maxOutputTokens).toBeLessThanOrEqual(
            8192
        );
    });

    it('prefers owned_by when the catalog has no entry', () => {
        const info = toChatInformation(
            { id: 'llama-3.3-70b', owned_by: 'groq' },
            undefined
        );
        expect(info.family).toBe('groq');
        expect(info.detail).toBe('Agent Router · groq');
    });
});

describe('isChatModel', () => {
    it('excludes modes that cannot answer a chat request', () => {
        for (const mode of ['embedding', 'image_generation', 'rerank']) {
            expect(
                isChatModel({ id: `some-${mode}` }, {
                    model: `some-${mode}`,
                    mode,
                })
            ).toBe(false);
        }
    });

    it('includes responses-mode models', () => {
        // Every OpenAI model is catalogued as `responses`, describing the
        // upstream API rather than what the Agent Router exposes. Excluding
        // them would drop the whole OpenAI line-up.
        expect(
            isChatModel({ id: 'gpt-5.6-terra' }, {
                model: 'gpt-5.6-terra',
                mode: 'responses',
            })
        ).toBe(true);
    });

    it('treats an unrecognized mode as usable', () => {
        expect(
            isChatModel({ id: 'future-model' }, {
                model: 'future-model',
                mode: 'something-new',
            })
        ).toBe(true);
    });

    it('trusts the catalog mode over the id', () => {
        // The id looks like an embedding model, but the catalog disagrees.
        expect(
            isChatModel({ id: 'embed-chatty' }, {
                model: 'embed-chatty',
                mode: 'chat',
            })
        ).toBe(true);
    });

    it('falls back to the id when the catalog is silent', () => {
        expect(isChatModel({ id: 'gemini-embedding-001' }, undefined)).toBe(
            false
        );
        expect(isChatModel({ id: 'text-embedding-3-large' }, undefined)).toBe(
            false
        );
        expect(isChatModel({ id: 'rerank-v2' }, undefined)).toBe(false);
        expect(isChatModel({ id: 'claude-opus-5' }, undefined)).toBe(true);
        expect(isChatModel({ id: 'gpt-5.6-terra' }, undefined)).toBe(true);
    });
});

describe('selectChatModels', () => {
    const catalog = new Map<string, CatalogModel>([
        ['claude-opus-5', opus],
        [
            'gemini-embedding-001',
            { model: 'gemini-embedding-001', mode: 'embedding' },
        ],
    ]);

    const apiModels: ApiModel[] = [
        { id: 'gemini-embedding-001' },
        { id: 'claude-opus-5' },
        { id: 'claude-opus-5' },
        { id: 'gpt-5-mini' },
    ];

    it('drops non-chat models and duplicates, then sorts by name', () => {
        const models = selectChatModels(apiModels, catalog, {
            modelFilter: [],
        });
        expect(models.map((model) => model.id)).toEqual([
            'claude-opus-5',
            'gpt-5-mini',
        ]);
    });

    it('applies the configured filter', () => {
        const models = selectChatModels(apiModels, catalog, {
            modelFilter: ['claude-*'],
        });
        expect(models.map((model) => model.id)).toEqual(['claude-opus-5']);
    });
});

describe('versionOf', () => {
    it('reads a two-part version from a hyphenated id', () => {
        expect(versionOf('claude-sonnet-4-5')).toBe('4.5');
        expect(versionOf('gpt-5.6-terra')).toBe('5.6');
        expect(versionOf('gemini-3.1-pro-preview')).toBe('3.1');
    });

    it('keeps a trailing date snapshot', () => {
        expect(versionOf('claude-opus-4-5-20251101')).toBe('4.5-20251101');
    });

    it('handles single-number and version-free ids', () => {
        expect(versionOf('claude-opus-5')).toBe('5.0');
        expect(versionOf('some-model')).toBe('1.0');
    });
});

describe('familyOf', () => {
    it('prefers the provider name', () => {
        expect(familyOf('claude-opus-5', 'anthropic')).toBe('anthropic');
    });

    it('falls back to the id prefix', () => {
        expect(familyOf('gpt-5-mini', undefined)).toBe('gpt');
        expect(familyOf('claude-opus-5', 'unknown')).toBe('claude');
    });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
        ...init,
    });
}

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

describe('network behaviour', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('fetchApiModels', () => {
        it('keeps only entries that carry an id', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve(
                        jsonResponse({ data: [{ id: 'a' }, { owned_by: 'x' }] })
                    )
                )
            );

            await expect(
                fetchApiModels('https://x/v1', 'k', {})
            ).resolves.toEqual([{ id: 'a' }]);
        });

        it('sends the key alongside the configured headers', async () => {
            const fetchMock = vi.fn(() =>
                Promise.resolve(jsonResponse({ data: [] }))
            );
            vi.stubGlobal('fetch', fetchMock);

            await fetchApiModels('https://x/v1', 'secret', {
                'X-Tenant-Id': 'team',
            });

            const [url, init] = fetchMock.mock.calls[0] as unknown as [
                string,
                RequestInit,
            ];
            expect(url).toBe('https://x/v1/models');
            expect(init.headers).toMatchObject({
                Accept: 'application/json',
                Authorization: 'Bearer secret',
                'X-Tenant-Id': 'team',
            });
        });

        it('retries a transient failure', async () => {
            const fetchMock = vi
                .fn()
                .mockImplementationOnce(() =>
                    Promise.resolve(
                        jsonResponse({}, {
                            status: 503,
                            statusText: 'Service Unavailable',
                        })
                    )
                )
                .mockImplementationOnce(() =>
                    Promise.resolve(jsonResponse({ data: [{ id: 'a' }] }))
                );
            vi.stubGlobal('fetch', fetchMock);

            const pending = fetchApiModels('https://x/v1', 'k', {});
            await vi.advanceTimersByTimeAsync(5_000);

            await expect(pending).resolves.toEqual([{ id: 'a' }]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('gives up after the configured attempts', async () => {
            const fetchMock = vi.fn(() =>
                Promise.resolve(
                    jsonResponse({}, {
                        status: 503,
                        statusText: 'Service Unavailable',
                    })
                )
            );
            vi.stubGlobal('fetch', fetchMock);

            const pending = fetchApiModels('https://x/v1', 'k', {});
            const failure = expect(pending).rejects.toThrow(/503/);
            await vi.advanceTimersByTimeAsync(30_000);
            await failure;

            expect(fetchMock).toHaveBeenCalledTimes(MODELS_ATTEMPTS);
        });

        it('does not retry a rejected key', async () => {
            const fetchMock = vi.fn(() =>
                Promise.resolve(
                    jsonResponse({}, {
                        status: 401,
                        statusText: 'Unauthorized',
                    })
                )
            );
            vi.stubGlobal('fetch', fetchMock);

            await expect(
                fetchApiModels('https://x/v1', 'k', {})
            ).rejects.toThrow(/401/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('times out instead of waiting forever on a silent host', async () => {
            vi.stubGlobal('fetch', hangingFetch());

            const pending = fetchApiModels('https://x/v1', 'k', {});
            const failure = expect(pending).rejects.toBeInstanceOf(
                RequestTimeoutError
            );
            await vi.advanceTimersByTimeAsync(
                MODELS_TIMEOUT_MS * MODELS_ATTEMPTS + 10_000
            );
            await failure;
        });

        it('explains a non-JSON 200 rather than leaking a parser error', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve(
                        new Response('<html>Sign in to the proxy</html>', {
                            headers: { 'content-type': 'text/html' },
                        })
                    )
                )
            );

            await expect(
                fetchApiModels('https://x/v1', 'k', {})
            ).rejects.toThrow(
                /Expected JSON from GET https:\/\/x\/v1\/models but received text\/html/
            );
        });

        it('never leaves the wire for an already-cancelled token', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const token = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose() {} }),
            } as unknown as vscode.CancellationToken;

            await expect(
                fetchApiModels('https://x/v1', 'k', {}, token)
            ).rejects.toThrow(/cancelled/);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('fetchPublicCatalogModels', () => {
        it('reports unreachable as undefined rather than as an empty catalog', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() => Promise.reject(new Error('ENOTFOUND')))
            );
            await expect(fetchPublicCatalogModels()).resolves.toBeUndefined();
        });

        it('abandons a slow catalog so discovery is not held up', async () => {
            vi.stubGlobal('fetch', hangingFetch());

            const pending = fetchPublicCatalogModels();
            await vi.advanceTimersByTimeAsync(CATALOG_TIMEOUT_MS + 100);

            await expect(pending).resolves.toBeUndefined();
        });

        it('drops entries with no model id', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve(
                        jsonResponse({
                            models: [{ model: 'a' }, { provider: 'x' }],
                        })
                    )
                )
            );
            await expect(fetchPublicCatalogModels()).resolves.toEqual([
                { model: 'a' },
            ]);
        });
    });
});
