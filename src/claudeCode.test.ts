import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    applyPassthrough,
    buildModelCache,
    claudeConfigDir,
    detectState,
    keyFingerprint,
    modelCachePath,
    parseSettings,
    proxyHostOf,
    readHeader,
    readModelCacheBaseUrl,
    readSettings,
    type RecordedIntegration,
    removePassthrough,
    replaceKey,
    settingsPath,
    withHeader,
    withoutHeader,
    writeModelCache,
    writeSettings,
} from './claudeCode';

const HOST = 'https://router.tare-acme.tetrate.ai';

function recorded(
    partial: Partial<RecordedIntegration> = {}
): RecordedIntegration {
    return {
        configDir: '/unused',
        host: HOST,
        keyFingerprint: keyFingerprint('sk-tars'),
        discovery: true,
        at: 0,
        ...partial,
    };
}

describe('claudeConfigDir', () => {
    it('honours CLAUDE_CONFIG_DIR and falls back to ~/.claude', () => {
        expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude' }, '/home/u')).toBe(
            '/opt/claude'
        );
        expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u')).toBe(
            path.join('/home/u', '.claude')
        );
        expect(claudeConfigDir({}, '/home/u')).toBe(
            path.join('/home/u', '.claude')
        );
    });
});

describe('proxyHostOf', () => {
    it('drops the version segment Anthropic clients append themselves', () => {
        expect(proxyHostOf(`${HOST}/v1`)).toBe(HOST);
        expect(proxyHostOf('https://gw.internal/proxy/v1/')).toBe(
            'https://gw.internal/proxy'
        );
        expect(proxyHostOf('http://localhost:8080/v2')).toBe(
            'http://localhost:8080'
        );
    });
});

describe('parseSettings', () => {
    it('reads a missing or empty file as empty settings', () => {
        expect(parseSettings(undefined)).toEqual({ ok: true, settings: {} });
        expect(parseSettings('  \n')).toEqual({ ok: true, settings: {} });
    });

    it('refuses anything it would have to guess at', () => {
        expect(parseSettings('{ "a": 1, }').ok).toBe(false);
        expect(parseSettings('[1]')).toMatchObject({
            ok: false,
            reason: 'the top level is not an object',
        });
        expect(parseSettings('{"env": []}')).toMatchObject({
            ok: false,
            reason: 'its "env" entry is not an object',
        });
    });
});

describe('header lists', () => {
    it('reads a header case-insensitively', () => {
        expect(readHeader('X-Team: infra\nx-TARS-api-key: sk-1', 'x-tars-api-key')).toBe(
            'sk-1'
        );
        expect(readHeader(undefined, 'x-tars-api-key')).toBeUndefined();
    });

    it('replaces the one header and keeps the rest', () => {
        expect(
            withHeader('X-Team: infra\nx-tars-api-key: old', 'x-tars-api-key', 'new')
        ).toBe('X-Team: infra\nx-tars-api-key: new');
        expect(withHeader(undefined, 'x-tars-api-key', 'new')).toBe(
            'x-tars-api-key: new'
        );
    });

    it('removes the header, reporting an emptied list as undefined', () => {
        expect(
            withoutHeader('X-Team: infra\r\nx-tars-api-key: k', 'x-tars-api-key')
        ).toBe('X-Team: infra');
        expect(withoutHeader('x-tars-api-key: k', 'x-tars-api-key')).toBeUndefined();
    });
});

describe('applyPassthrough', () => {
    it('sets the base URL, the key header, and discovery, keeping other settings', () => {
        const { settings, removedCredentials } = applyPassthrough(
            {
                model: 'opus',
                env: {
                    API_TIMEOUT_MS: '1200000',
                    ANTHROPIC_CUSTOM_HEADERS: 'X-Team: infra',
                },
            },
            { host: HOST, key: ' sk-tars ', discovery: true }
        );

        expect(removedCredentials).toEqual([]);
        expect(settings).toEqual({
            model: 'opus',
            env: {
                API_TIMEOUT_MS: '1200000',
                ANTHROPIC_BASE_URL: HOST,
                ANTHROPIC_CUSTOM_HEADERS: 'X-Team: infra\nx-tars-api-key: sk-tars',
                CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
            },
        });
    });

    it('removes credentials that would override the subscription sign-in', () => {
        const { settings, removedCredentials } = applyPassthrough(
            { env: { ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_AUTH_TOKEN: 't' } },
            { host: HOST, key: 'sk-tars', discovery: false }
        );

        expect(removedCredentials).toEqual([
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
        ]);
        expect(settings.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(settings.env).not.toHaveProperty(
            'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'
        );
    });
});

describe('removePassthrough', () => {
    it('undoes exactly what was written', () => {
        const before = {
            model: 'opus',
            env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: infra', OTHER: '1' },
        };
        const { settings } = applyPassthrough(before, {
            host: HOST,
            key: 'sk-tars',
            discovery: true,
        });

        expect(removePassthrough(settings, recorded())).toEqual({
            settings: before,
            kept: [],
        });
    });

    it('drops an emptied env block entirely', () => {
        const { settings } = applyPassthrough(
            {},
            { host: HOST, key: 'sk-tars', discovery: true }
        );
        expect(removePassthrough(settings, recorded()).settings).toEqual({});
    });

    it('keeps values the user changed by hand, and names them', () => {
        const { settings, kept } = removePassthrough(
            {
                env: {
                    ANTHROPIC_BASE_URL: 'https://elsewhere.example.com',
                    ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-other',
                },
            },
            recorded()
        );

        expect(kept).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']);
        expect(settings.env).toEqual({
            ANTHROPIC_BASE_URL: 'https://elsewhere.example.com',
            ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-other',
        });
    });
});

describe('replaceKey', () => {
    it('swaps the key without re-asserting anything else', () => {
        expect(
            replaceKey(
                { env: { ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: old' } },
                'new'
            )
        ).toEqual({ env: { ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: new' } });
    });
});

describe('detectState', () => {
    const target = { host: HOST, key: 'sk-tars' };
    const configured = (env: Record<string, string>) =>
        detectState({ ok: true, settings: { env } }, target);

    it('reports each routing', () => {
        expect(detectState({ ok: false, reason: 'x' }, target)).toBe('unparseable');
        expect(configured({})).toBe('not-configured');
        expect(
            configured({
                ANTHROPIC_BASE_URL: `${HOST}/`,
                ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-tars',
            })
        ).toBe('passthrough-here');
        expect(
            configured({
                ANTHROPIC_BASE_URL: HOST,
                ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-revoked',
            })
        ).toBe('passthrough-stale-key');
        expect(configured({ ANTHROPIC_BASE_URL: HOST })).toBe(
            'passthrough-stale-key'
        );
        expect(
            configured({ ANTHROPIC_BASE_URL: 'https://other.example.com' })
        ).toBe('other-endpoint');
        expect(
            configured({ ANTHROPIC_BASE_URL: HOST, ANTHROPIC_API_KEY: 'sk-tars' })
        ).toBe('managed');
    });

    it('cannot vouch for a configuration once the key is cleared', () => {
        expect(
            detectState(
                {
                    ok: true,
                    settings: {
                        env: {
                            ANTHROPIC_BASE_URL: HOST,
                            ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-tars',
                        },
                    },
                },
                { host: HOST, key: undefined }
            )
        ).toBe('passthrough-stale-key');
    });
});

describe('buildModelCache', () => {
    const models = [
        { id: 'claude-opus-5', family: 'anthropic' },
        { id: 'vertex/claude-sonnet-5', family: 'vertex' },
        { id: 'gpt-5.6-terra', family: 'openai' },
        { id: 'claude-opus-5', family: 'anthropic' },
    ];

    it('lists the Anthropic models by default, deduplicated', () => {
        expect(buildModelCache(models, HOST, 'anthropic', 42)).toEqual({
            baseUrl: HOST,
            fetchedAt: 42,
            models: [{ id: 'claude-opus-5' }, { id: 'vertex/claude-sonnet-5' }],
        });
    });

    it('lists everything on request', () => {
        expect(buildModelCache(models, HOST, 'all', 42).models).toHaveLength(3);
    });
});

describe('settings files', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'claude-code-test-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('reports a missing file as absent and empty', async () => {
        await expect(readSettings(dir)).resolves.toEqual({
            exists: false,
            parsed: { ok: true, settings: {} },
        });
    });

    it('writes owner-only and backs up the previous file on request', async () => {
        await writeFile(settingsPath(dir), '{"model":"opus"}');

        const backup = await writeSettings(dir, { env: { A: '1' } }, { backupAt: 0 });

        expect(JSON.parse(await readFile(settingsPath(dir), 'utf8'))).toEqual({
            env: { A: '1' },
        });
        expect(await readFile(backup!, 'utf8')).toBe('{"model":"opus"}');
        if (process.platform !== 'win32') {
            expect((await stat(settingsPath(dir))).mode & 0o777).toBe(0o600);
            expect((await stat(backup!)).mode & 0o777).toBe(0o600);
        }
        // No temporary file is left behind by the atomic write.
        expect((await readdir(dir)).sort()).toEqual(
            [path.basename(backup!), 'settings.json'].sort()
        );
    });

    it('creates the config directory for a first write', async () => {
        const nested = path.join(dir, 'fresh');
        await writeSettings(nested, { env: {} });
        await expect(readSettings(nested)).resolves.toMatchObject({ exists: true });
    });

    it('round-trips the model cache', async () => {
        await writeModelCache(dir, buildModelCache([{ id: 'claude-x' }], HOST, 'all', 1));

        expect(JSON.parse(await readFile(modelCachePath(dir), 'utf8'))).toEqual({
            baseUrl: HOST,
            fetchedAt: 1,
            models: [{ id: 'claude-x' }],
        });
        await expect(readModelCacheBaseUrl(dir)).resolves.toBe(HOST);
    });

    it('reads a missing or foreign cache as having no base URL', async () => {
        await expect(readModelCacheBaseUrl(dir)).resolves.toBeUndefined();
        await writeModelCache(dir, { nope: true } as never);
        await expect(readModelCacheBaseUrl(dir)).resolves.toBeUndefined();
    });
});
