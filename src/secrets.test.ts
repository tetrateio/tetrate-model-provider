import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import {
    API_KEY_SECRET,
    apiKeySecretName,
    deleteApiKey,
    getApiKey,
    storeApiKey,
} from './secrets';

const HOSTED = 'https://api.router.tetrate.ai/v1';
const SELF_HOSTED = 'https://gateway.internal:8443/v1';

function fakeContext(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const context = {
        secrets: {
            get: (key: string) => Promise.resolve(store.get(key)),
            store: (key: string, value: string) => {
                store.set(key, value);
                return Promise.resolve();
            },
            delete: (key: string) => {
                store.delete(key);
                return Promise.resolve();
            },
        },
    } as unknown as vscode.ExtensionContext;
    return { context, store };
}

describe('apiKeySecretName', () => {
    it('scopes by host and port, case-insensitively', () => {
        expect(apiKeySecretName(HOSTED)).toBe(
            `${API_KEY_SECRET}:api.router.tetrate.ai`
        );
        expect(apiKeySecretName(SELF_HOSTED)).toBe(
            `${API_KEY_SECRET}:gateway.internal:8443`
        );
        expect(apiKeySecretName('https://API.Router.Tetrate.AI/v1')).toBe(
            apiKeySecretName(HOSTED)
        );
    });

    it('gives paths on one host the same name', () => {
        expect(apiKeySecretName('https://gw.internal/v1')).toBe(
            apiKeySecretName('https://gw.internal/proxy/v1')
        );
    });

    it('still scopes on a base URL that does not parse', () => {
        expect(apiKeySecretName('not a url')).toBe(
            `${API_KEY_SECRET}:not a url`
        );
    });
});

describe('getApiKey', () => {
    it('keeps keys apart per host', async () => {
        const { context } = fakeContext();
        await storeApiKey(context, HOSTED, 'sk-hosted');
        await storeApiKey(context, SELF_HOSTED, 'sk-internal');

        await expect(getApiKey(context, HOSTED)).resolves.toBe('sk-hosted');
        await expect(getApiKey(context, SELF_HOSTED)).resolves.toBe(
            'sk-internal'
        );
    });

    it('falls back to the legacy unscoped key after an upgrade', async () => {
        const { context } = fakeContext({ [API_KEY_SECRET]: 'sk-legacy' });

        await expect(getApiKey(context, HOSTED)).resolves.toBe('sk-legacy');
        await expect(getApiKey(context, SELF_HOSTED)).resolves.toBe(
            'sk-legacy'
        );
    });

    it('prefers a scoped key over the legacy one', async () => {
        const { context } = fakeContext({ [API_KEY_SECRET]: 'sk-legacy' });
        await storeApiKey(context, HOSTED, 'sk-hosted');

        await expect(getApiKey(context, HOSTED)).resolves.toBe('sk-hosted');
    });

    it('treats a blank stored value as absent', async () => {
        const { context } = fakeContext({
            [apiKeySecretName(HOSTED)]: '   ',
        });
        await expect(getApiKey(context, HOSTED)).resolves.toBeUndefined();
    });
});

describe('deleteApiKey', () => {
    it('removes the scoped key and the legacy fallback', async () => {
        const { context, store } = fakeContext({
            [API_KEY_SECRET]: 'sk-legacy',
        });
        await storeApiKey(context, HOSTED, 'sk-hosted');

        await deleteApiKey(context, HOSTED);

        await expect(getApiKey(context, HOSTED)).resolves.toBeUndefined();
        expect(store.has(API_KEY_SECRET)).toBe(false);
    });

    it('leaves other hosts untouched', async () => {
        const { context } = fakeContext();
        await storeApiKey(context, HOSTED, 'sk-hosted');
        await storeApiKey(context, SELF_HOSTED, 'sk-internal');

        await deleteApiKey(context, HOSTED);

        await expect(getApiKey(context, SELF_HOSTED)).resolves.toBe(
            'sk-internal'
        );
    });
});
