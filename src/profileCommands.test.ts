import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
    addProfileFlow,
    profileNameOf,
    removeProfileFlow,
} from './profileCommands';

const { configValues } = vscode as unknown as {
    configValues: Record<string, unknown>;
};

type WindowStubs = {
    showInputBox: unknown;
    showQuickPick: unknown;
    showInformationMessage: unknown;
};

const mockWindow = vscode.window as unknown as WindowStubs;
const originals: WindowStubs = {
    showInputBox: mockWindow.showInputBox,
    showQuickPick: mockWindow.showQuickPick,
    showInformationMessage: mockWindow.showInformationMessage,
};

function stubInputs(...values: Array<string | undefined>) {
    let index = 0;
    mockWindow.showInputBox = () => Promise.resolve(values[index++]);
}

beforeEach(() => {
    for (const key of Object.keys(configValues)) {
        delete configValues[key];
    }
});

afterEach(() => {
    mockWindow.showInputBox = originals.showInputBox;
    mockWindow.showQuickPick = originals.showQuickPick;
    mockWindow.showInformationMessage = originals.showInformationMessage;
});

describe('addProfileFlow', () => {
    it('writes a normalized URL under the trimmed name', async () => {
        configValues.profiles = { Existing: 'https://old.example.com/v1' };
        stubInputs('  Staging  ', 'https://staging.example.com/');

        await addProfileFlow();

        expect(configValues.profiles).toEqual({
            Existing: 'https://old.example.com/v1',
            Staging: 'https://staging.example.com/v1',
        });
    });

    it('aborts on a blank name without writing', async () => {
        stubInputs('   ');
        await addProfileFlow();
        expect(configValues.profiles).toBeUndefined();
    });

    it('aborts when the URL prompt is dismissed', async () => {
        stubInputs('Staging', undefined);
        await addProfileFlow();
        expect(configValues.profiles).toBeUndefined();
    });
});

describe('removeProfileFlow', () => {
    it('deletes the entry picked from the quick pick', async () => {
        configValues.profiles = {
            Production: 'https://api.router.tetrate.ai/v1',
            Staging: 'https://staging.example.com/v1',
        };
        mockWindow.showQuickPick = () => Promise.resolve('Staging');

        await removeProfileFlow();

        expect(configValues.profiles).toEqual({
            Production: 'https://api.router.tetrate.ai/v1',
        });
    });

    it('deletes the named entry without asking', async () => {
        configValues.profiles = {
            Production: 'https://api.router.tetrate.ai/v1',
        };
        await removeProfileFlow('Production');
        expect(configValues.profiles).toEqual({});
    });

    it('shows a message instead of erroring when nothing exists', async () => {
        let message: string | undefined;
        mockWindow.showInformationMessage = (text: string) => {
            message = text;
            return Promise.resolve(undefined);
        };

        await expect(removeProfileFlow()).resolves.toBeUndefined();
        expect(message).toContain('No endpoint profiles');
        expect(configValues.profiles).toBeUndefined();
    });

    it('shows a message for an unknown name instead of writing', async () => {
        configValues.profiles = {
            Production: 'https://api.router.tetrate.ai/v1',
        };
        let message: string | undefined;
        mockWindow.showInformationMessage = (text: string) => {
            message = text;
            return Promise.resolve(undefined);
        };

        await removeProfileFlow('Ghost');

        expect(message).toContain('Ghost');
        expect(configValues.profiles).toEqual({
            Production: 'https://api.router.tetrate.ai/v1',
        });
    });
});

describe('profileNameOf', () => {
    it('extracts the name from a profile tree node', () => {
        expect(
            profileNameOf({
                kind: 'profile',
                name: 'Staging',
                url: 'https://staging.example.com/v1',
            })
        ).toBe('Staging');
    });

    it('returns undefined for anything else', () => {
        expect(profileNameOf(undefined)).toBeUndefined();
        expect(profileNameOf('Staging')).toBeUndefined();
        expect(profileNameOf({ kind: 'leaf', label: 'x' })).toBeUndefined();
    });
});
