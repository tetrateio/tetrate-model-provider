import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
    buildCommandCenterItems,
    type CommandCenterItem,
    showCommandCenter,
} from './commandCenter';

const state = {
    baseUrl: 'https://api.router.tetrate.ai/v1',
    sessionHeadline: '$0.1234',
    todayCost: '$0.42',
};

describe('buildCommandCenterItems', () => {
    it('lists the actions in order with their separators', () => {
        const items = buildCommandCenterItems(state);

        expect(
            items.map((item) =>
                item.kind === vscode.QuickPickItemKind.Separator
                    ? `-- ${item.label}`
                    : item.commandId
            )
        ).toEqual([
            '-- https://api.router.tetrate.ai/v1',
            'tetrate-model-provider.showUsage',
            'tetrate-model-provider.chooseModels',
            'tetrate-model-provider.switchEndpoint',
            'tetrate-model-provider.refreshModels',
            '-- Setup',
            'tetrate-model-provider.setApiKey',
            'tetrate-model-provider.testConnection',
            'tetrate-model-provider.showStatus',
        ]);
    });

    it('titles the endpoint separator with the profile name when given', () => {
        const items = buildCommandCenterItems({
            ...state,
            profileName: 'staging',
        });
        expect(items[0]).toMatchObject({
            label: 'staging',
            kind: vscode.QuickPickItemKind.Separator,
        });
    });

    it('surfaces the cost figures and the endpoint as descriptions', () => {
        const items = buildCommandCenterItems(state);
        const dashboard = items.find(
            (item) => item.commandId === 'tetrate-model-provider.showUsage'
        );
        const endpoint = items.find(
            (item) => item.commandId === 'tetrate-model-provider.switchEndpoint'
        );

        expect(dashboard?.description).toBe(
            '$0.42 today · $0.1234 this session'
        );
        expect(endpoint?.description).toBe('https://api.router.tetrate.ai/v1');
    });
});

/**
 * Runs showCommandCenter with a stubbed pick result and a spied
 * executeCommand, restoring both mock surfaces afterwards.
 */
async function runCommandCenter(
    pick: (items: CommandCenterItem[]) => CommandCenterItem | undefined
) {
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    const originalPick = vscode.window.showQuickPick;
    const originalExecute = vscode.commands.executeCommand;
    (vscode.window as { showQuickPick: unknown }).showQuickPick = (
        items: CommandCenterItem[]
    ) => Promise.resolve(pick(items));
    (vscode.commands as { executeCommand: unknown }).executeCommand =
        executeCommand;
    try {
        await showCommandCenter(state);
    } finally {
        (vscode.window as { showQuickPick: unknown }).showQuickPick =
            originalPick;
        (vscode.commands as { executeCommand: unknown }).executeCommand =
            originalExecute;
    }
    return executeCommand;
}

describe('showCommandCenter', () => {
    it('executes the picked command', async () => {
        const executeCommand = await runCommandCenter((items) =>
            items.find(
                (item) =>
                    item.commandId === 'tetrate-model-provider.testConnection'
            )
        );

        expect(executeCommand).toHaveBeenCalledExactlyOnceWith(
            'tetrate-model-provider.testConnection'
        );
    });

    it('does nothing on dismissal', async () => {
        const executeCommand = await runCommandCenter(() => undefined);
        expect(executeCommand).not.toHaveBeenCalled();
    });
});
