import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { keyFingerprint, modelCachePath, settingsPath } from './claudeCode';
import {
    CLAUDE_INTEGRATION_KEY,
    type ClaudeCodeDeps,
    claudeCodeState,
    configureClaudeCodeFlow,
    readRecorded,
    refreshClaudeCodeModels,
    removeClaudeCodeFlow,
    syncClaudeCodeKey,
} from './claudeCodeCommands';

const HOST = 'https://router.tare-acme.tetrate.ai';

const { configValues } = vscode as unknown as {
    configValues: Record<string, unknown>;
};

type WindowStubs = {
    showWarningMessage: unknown;
    showInformationMessage: unknown;
    showErrorMessage: unknown;
};
const mockWindow = vscode.window as unknown as WindowStubs;
const originals: WindowStubs = { ...mockWindow };

let dir: string;

function makeDeps(overrides: Partial<ClaudeCodeDeps> = {}) {
    const values = new Map<string, unknown>();
    let key: string | undefined = 'sk-tars';
    const deps: ClaudeCodeDeps = {
        store: {
            get: <T>(name: string) => values.get(name) as T | undefined,
            update: (name: string, value: unknown) => {
                values.set(name, value);
                return Promise.resolve();
            },
        },
        apiKey: () => Promise.resolve(key),
        fetchModels: () =>
            Promise.resolve([
                { id: 'claude-opus-5', family: 'anthropic' },
                { id: 'gpt-5.6-terra', family: 'openai' },
            ]),
        configDir: () => dir,
        log: { info: vi.fn(), warn: vi.fn() },
        ...overrides,
    };
    return {
        deps,
        values,
        setKey: (next: string | undefined) => {
            key = next;
        },
    };
}

/** Answers every prompt with the first offered action whose label matches. */
function answer(labels: string[]) {
    const pick = (_message: string, ...rest: unknown[]) => {
        const actions = rest.filter((item): item is string => typeof item === 'string');
        return Promise.resolve(actions.find((action) => labels.includes(action)));
    };
    mockWindow.showWarningMessage = vi.fn(pick);
    mockWindow.showInformationMessage = vi.fn(pick);
    mockWindow.showErrorMessage = vi.fn(pick);
}

async function settingsOnDisk(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath(dir), 'utf8')) as Record<
        string,
        unknown
    >;
}

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'claude-code-flow-'));
    for (const name of Object.keys(configValues)) {
        delete configValues[name];
    }
    configValues.baseUrl = `${HOST}/v1`;
});

afterEach(async () => {
    Object.assign(mockWindow, originals);
    await rm(dir, { recursive: true, force: true });
});

describe('configureClaudeCodeFlow', () => {
    it('writes passthrough settings and the picker cache once confirmed', async () => {
        await writeFile(settingsPath(dir), '{"model":"opus"}');
        const { deps, values } = makeDeps();
        answer(['Configure']);

        await expect(configureClaudeCodeFlow(deps)).resolves.toBe(true);

        expect(await settingsOnDisk()).toEqual({
            model: 'opus',
            env: {
                ANTHROPIC_BASE_URL: HOST,
                ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-tars',
                CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
            },
        });
        const cache = JSON.parse(await readFile(modelCachePath(dir), 'utf8')) as {
            models: unknown[];
        };
        expect(cache.models).toEqual([{ id: 'claude-opus-5' }]);
        // The record carries a fingerprint, never the key.
        const record = values.get(CLAUDE_INTEGRATION_KEY);
        expect(record).toMatchObject({
            host: HOST,
            keyFingerprint: keyFingerprint('sk-tars'),
        });
        expect(JSON.stringify(record)).not.toContain('sk-tars');
        await expect(claudeCodeState(deps)).resolves.toBe('passthrough-here');
    });

    it('writes nothing when the prompt is declined', async () => {
        const { deps } = makeDeps();
        answer([]);

        await expect(configureClaudeCodeFlow(deps)).resolves.toBe(false);
        await expect(readFile(settingsPath(dir), 'utf8')).rejects.toThrow();
    });

    it('writes nothing when the key is rejected', async () => {
        const { deps } = makeDeps({
            fetchModels: () => Promise.reject(new Error('HTTP 401')),
        });
        answer(['Configure']);

        await expect(configureClaudeCodeFlow(deps)).resolves.toBe(false);
        await expect(readFile(settingsPath(dir), 'utf8')).rejects.toThrow();
        expect(mockWindow.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('HTTP 401')
        );
    });

    it('refuses to touch a settings file it cannot parse', async () => {
        await writeFile(settingsPath(dir), '{ broken');
        const { deps } = makeDeps();
        answer(['Configure']);

        await expect(configureClaudeCodeFlow(deps)).resolves.toBe(false);
        expect(await readFile(settingsPath(dir), 'utf8')).toBe('{ broken');
    });

    it('asks for a key before anything else', async () => {
        const { deps, setKey } = makeDeps();
        setKey(undefined);
        answer(['Configure']);

        await expect(configureClaudeCodeFlow(deps)).resolves.toBe(false);
        expect(mockWindow.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('No Agent Router API key')
        );
    });

    it('skips the picker cache when the setting is off', async () => {
        configValues['claudeCode.pickerModels'] = 'off';
        const { deps } = makeDeps();
        answer(['Configure']);

        await configureClaudeCodeFlow(deps);

        expect((await settingsOnDisk()).env).not.toHaveProperty(
            'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'
        );
        await expect(readFile(modelCachePath(dir), 'utf8')).rejects.toThrow();
    });
});

describe('removeClaudeCodeFlow', () => {
    it('restores the file and deletes the cache it wrote', async () => {
        await writeFile(settingsPath(dir), '{"model":"opus"}');
        const { deps, values } = makeDeps();
        answer(['Configure']);
        await configureClaudeCodeFlow(deps);

        await expect(removeClaudeCodeFlow(deps)).resolves.toBe(true);

        expect(await settingsOnDisk()).toEqual({ model: 'opus' });
        await expect(readFile(modelCachePath(dir), 'utf8')).rejects.toThrow();
        expect(values.get(CLAUDE_INTEGRATION_KEY)).toBeUndefined();
    });

    it('changes nothing without a record of a configuration', async () => {
        await writeFile(settingsPath(dir), '{"model":"opus"}');
        const { deps } = makeDeps();
        answer([]);

        await expect(removeClaudeCodeFlow(deps)).resolves.toBe(false);
        expect(await readFile(settingsPath(dir), 'utf8')).toBe('{"model":"opus"}');
    });
});

describe('refreshClaudeCodeModels', () => {
    it('rewrites the cache from the current list', async () => {
        const models = [{ id: 'claude-opus-5', family: 'anthropic' }];
        const { deps } = makeDeps({ fetchModels: () => Promise.resolve(models) });
        answer(['Configure']);
        await configureClaudeCodeFlow(deps);

        models.push({ id: 'claude-haiku-5', family: 'anthropic' });
        await refreshClaudeCodeModels(deps, { quiet: true });

        const cache = JSON.parse(await readFile(modelCachePath(dir), 'utf8')) as {
            models: unknown[];
        };
        expect(cache.models).toHaveLength(2);
    });

    it('leaves another endpoint’s configuration alone', async () => {
        const { deps } = makeDeps();
        answer(['Configure']);
        await configureClaudeCodeFlow(deps);
        await rm(modelCachePath(dir));

        configValues.baseUrl = 'https://other.example.com/v1';
        await refreshClaudeCodeModels(deps, { quiet: true });

        await expect(readFile(modelCachePath(dir), 'utf8')).rejects.toThrow();
    });
});

describe('syncClaudeCodeKey', () => {
    it('offers the rotated key to Claude Code and records it', async () => {
        const { deps, values, setKey } = makeDeps();
        answer(['Configure', 'Update Claude Code']);
        await configureClaudeCodeFlow(deps);

        setKey('sk-rotated');
        await syncClaudeCodeKey(deps);

        expect((await settingsOnDisk()).env).toMatchObject({
            ANTHROPIC_CUSTOM_HEADERS: 'x-tars-api-key: sk-rotated',
        });
        expect(readRecorded(deps.store)?.keyFingerprint).toBe(
            keyFingerprint('sk-rotated')
        );
        expect(values.size).toBe(1);
    });

    it('offers removal when the key is cleared', async () => {
        const { deps, setKey } = makeDeps();
        answer(['Configure', 'Remove from Claude Code']);
        await configureClaudeCodeFlow(deps);

        setKey(undefined);
        await syncClaudeCodeKey(deps);

        expect(await settingsOnDisk()).toEqual({});
    });

    it('does nothing when the key is unchanged', async () => {
        const { deps } = makeDeps();
        answer(['Configure']);
        await configureClaudeCodeFlow(deps);
        const prompts = vi.mocked(
            mockWindow.showInformationMessage as () => unknown
        ).mock.calls.length;

        await syncClaudeCodeKey(deps);

        expect(
            vi.mocked(mockWindow.showInformationMessage as () => unknown).mock
                .calls.length
        ).toBe(prompts);
    });

    it('does not re-point a configuration the user moved elsewhere', async () => {
        const { deps, setKey } = makeDeps();
        answer(['Configure', 'Update Claude Code']);
        await configureClaudeCodeFlow(deps);
        await writeFile(
            settingsPath(dir),
            JSON.stringify({
                env: { ANTHROPIC_BASE_URL: 'https://other.example.com' },
            })
        );

        setKey('sk-rotated');
        await syncClaudeCodeKey(deps);

        expect(await settingsOnDisk()).toEqual({
            env: { ANTHROPIC_BASE_URL: 'https://other.example.com' },
        });
    });
});
