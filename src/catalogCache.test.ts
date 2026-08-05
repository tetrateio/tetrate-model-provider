import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogModel } from './catalog';
import {
    CATALOG_CACHE_KEY,
    CATALOG_TTL_MS,
    type CatalogStore,
    clearPublicCatalogCache,
    loadPublicCatalog,
} from './catalogCache';

const NOW = 1_800_000_000_000;

function makeStore(initial?: unknown): CatalogStore & {
    read(): unknown;
    writes: number;
} {
    let value = initial;
    let writes = 0;
    return {
        get<T>(key: string): T | undefined {
            return key === CATALOG_CACHE_KEY ? (value as T) : undefined;
        },
        update(key: string, next: unknown) {
            if (key === CATALOG_CACHE_KEY) {
                value = next;
                writes += 1;
            }
            return Promise.resolve();
        },
        read: () => value,
        get writes() {
            return writes;
        },
    };
}

function catalogResponse(models: CatalogModel[]): Response {
    return new Response(JSON.stringify({ models }), {
        headers: { 'content-type': 'application/json' },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('loadPublicCatalog', () => {
    it('serves a fresh cache without touching the network', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const store = makeStore({
            fetchedAt: NOW - 1000,
            models: [{ model: 'claude-opus-5', contextWindow: 1_000_000 }],
        });

        const catalog = await loadPublicCatalog(store, undefined, NOW);

        expect(catalog.get('claude-opus-5')?.contextWindow).toBe(1_000_000);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches and stores when nothing is cached', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(catalogResponse([{ model: 'gpt-5.6-terra' }]))
            )
        );
        const store = makeStore();

        const catalog = await loadPublicCatalog(store, undefined, NOW);

        expect([...catalog.keys()]).toEqual(['gpt-5.6-terra']);
        expect(store.read()).toMatchObject({ fetchedAt: NOW });
        expect(store.writes).toBe(1);
    });

    it('refetches once the entry is past its TTL', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(catalogResponse([{ model: 'new-model' }]))
        );
        vi.stubGlobal('fetch', fetchMock);
        const store = makeStore({
            fetchedAt: NOW - CATALOG_TTL_MS - 1,
            models: [{ model: 'old-model' }],
        });

        const catalog = await loadPublicCatalog(store, undefined, NOW);

        expect([...catalog.keys()]).toEqual(['new-model']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps serving a stale entry when the catalog is unreachable', async () => {
        // Yesterday's context windows beat the fallback constants, so an
        // offline start still gets real numbers.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('ENOTFOUND')))
        );
        const store = makeStore({
            fetchedAt: NOW - CATALOG_TTL_MS - 1,
            models: [{ model: 'old-model', contextWindow: 200_000 }],
        });

        const catalog = await loadPublicCatalog(store, undefined, NOW);

        expect(catalog.get('old-model')?.contextWindow).toBe(200_000);
        expect(store.writes).toBe(0);
    });

    it('returns an empty catalog when there is nothing cached and no network', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('ENOTFOUND')))
        );

        const catalog = await loadPublicCatalog(makeStore(), undefined, NOW);

        expect(catalog.size).toBe(0);
    });

    it('ignores a stored value written by an older shape', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(catalogResponse([{ model: 'a' }])))
        );
        const store = makeStore({ models: 'not-an-array' });

        const catalog = await loadPublicCatalog(store, undefined, NOW);

        expect([...catalog.keys()]).toEqual(['a']);
    });

    it('stores only the fields the provider reads, with a bounded description', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    catalogResponse([
                        {
                            model: 'claude-opus-5',
                            provider: 'anthropic',
                            mode: 'chat',
                            contextWindow: 1_000_000,
                            capabilities: ['vision'],
                            modalities: { input: ['image'], output: ['text'] },
                            limits: { max_output_tokens: 128_000 },
                            metadata: { description: 'x'.repeat(1000) },
                            // Not read by the provider, so not worth storing.
                            isEnabled: true,
                        },
                    ])
                )
            )
        );
        const store = makeStore();

        await loadPublicCatalog(store, undefined, NOW);
        const stored = store.read() as { models: CatalogModel[] };
        const model = stored.models[0] as CatalogModel;

        expect(model.isEnabled).toBeUndefined();
        expect(model.modalities?.output).toBeUndefined();
        expect(model.metadata?.description?.length).toBe(300);
        expect(model).toMatchObject({
            model: 'claude-opus-5',
            provider: 'anthropic',
            contextWindow: 1_000_000,
            limits: { max_output_tokens: 128_000 },
        });
    });

    it('survives a storage write that fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(catalogResponse([{ model: 'a' }])))
        );
        const store: CatalogStore = {
            get: () => undefined,
            update: () => Promise.reject(new Error('disk full')),
        };

        await expect(
            loadPublicCatalog(store, undefined, NOW)
        ).resolves.toHaveProperty('size', 1);
    });
});

describe('clearPublicCatalogCache', () => {
    it('removes the stored entry', async () => {
        const store = makeStore({ fetchedAt: NOW, models: [] });
        await clearPublicCatalogCache(store);
        expect(store.read()).toBeUndefined();
    });
});
