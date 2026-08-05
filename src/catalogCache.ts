import * as vscode from 'vscode';

import {
    type CatalogModel,
    fetchPublicCatalogModels,
    indexCatalog,
} from './catalog';

/**
 * The subset of {@link vscode.Memento} this module needs. Narrowing it keeps
 * the cache testable without an extension host.
 */
export type CatalogStore = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
};

export const CATALOG_CACHE_KEY = 'tetrate-model-provider.publicCatalog';

/**
 * The catalog changes when Tetrate adds a model, which is a matter of weeks,
 * not minutes. A day is short enough that a new model shows up on its own and
 * long enough that the round trip disappears from every start after the first.
 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounds what a description can contribute to the stored blob. */
const MAX_DESCRIPTION_LENGTH = 300;

type StoredCatalog = {
    fetchedAt: number;
    models: CatalogModel[];
};

/**
 * Returns catalog metadata, preferring a fresh cached copy over the network.
 *
 * The order of preference is fresh cache, then network, then stale cache. That
 * last step is what makes discovery useful offline: yesterday's context windows
 * are far closer to the truth than the fallback constants.
 */
export async function loadPublicCatalog(
    store: CatalogStore,
    token?: vscode.CancellationToken,
    now: number = Date.now()
): Promise<Map<string, CatalogModel>> {
    const cached = readCache(store);
    if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) {
        return indexCatalog(cached.models);
    }

    const fetched = await fetchPublicCatalogModels(token);
    if (!fetched) {
        return indexCatalog(cached?.models);
    }

    const models = fetched.map(compact);
    try {
        await store.update(CATALOG_CACHE_KEY, {
            fetchedAt: now,
            models,
        } satisfies StoredCatalog);
    } catch {
        // Storage is a nicety here; a write failure must not fail discovery.
    }
    return indexCatalog(models);
}

/** Drops the cached copy so the next load goes to the network. */
export async function clearPublicCatalogCache(
    store: CatalogStore
): Promise<void> {
    await store.update(CATALOG_CACHE_KEY, undefined);
}

/**
 * Anything written here survives upgrades, so read it defensively: a shape
 * from an older version must degrade to "no cache", not throw.
 */
function readCache(store: CatalogStore): StoredCatalog | undefined {
    const raw = store.get<StoredCatalog>(CATALOG_CACHE_KEY);
    if (
        !raw ||
        typeof raw.fetchedAt !== 'number' ||
        !Number.isFinite(raw.fetchedAt) ||
        !Array.isArray(raw.models)
    ) {
        return undefined;
    }
    return raw;
}

/**
 * Keeps only the fields the provider reads. Descriptions are the bulk of the
 * payload and are truncated, since they end up in a tooltip.
 */
function compact(model: CatalogModel): CatalogModel {
    const description = model.metadata?.description;
    const displayName = model.metadata?.display_name;
    const metadata =
        description !== undefined || displayName !== undefined
            ? {
                  ...(description !== undefined
                      ? { description: truncate(description) }
                      : {}),
                  ...(displayName !== undefined ? { display_name: displayName } : {}),
              }
            : undefined;

    return {
        model: model.model,
        ...(model.provider !== undefined ? { provider: model.provider } : {}),
        ...(model.displayName !== undefined
            ? { displayName: model.displayName }
            : {}),
        ...(model.mode !== undefined ? { mode: model.mode } : {}),
        ...(model.contextWindow !== undefined
            ? { contextWindow: model.contextWindow }
            : {}),
        ...(model.capabilities !== undefined
            ? { capabilities: model.capabilities }
            : {}),
        ...(model.modalities?.input !== undefined
            ? { modalities: { input: model.modalities.input } }
            : {}),
        ...(model.limits?.max_output_tokens !== undefined
            ? { limits: { max_output_tokens: model.limits.max_output_tokens } }
            : {}),
        ...(metadata ? { metadata } : {}),
    };
}

function truncate(text: string): string {
    return text.length > MAX_DESCRIPTION_LENGTH
        ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
        : text;
}
