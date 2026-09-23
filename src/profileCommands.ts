import * as vscode from 'vscode';

import { CONFIG_SECTION, normalizeBaseUrl } from './config';

/**
 * The Add Profile and Remove Profile flows behind the tree's Profiles rows.
 * Kept out of extension.ts so the tree and the commands can share the profile
 * node shape without pulling the whole activation module into tests.
 */

/**
 * Twin of extension.ts's validateBaseUrl. Importing it would create a cycle
 * once extension.ts registers these commands, so the rule lives here twice;
 * keep both in step.
 */
function validateBaseUrl(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return null; // falls back to the default
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return 'Enter a full URL, for example https://api.router.tetrate.ai/v1';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return 'The URL must use http or https.';
    }
    return null;
}

/**
 * Extracts the profile name from a tree node passed as a command argument.
 * Structural rather than typed, because the command also fires without an
 * argument (from the palette) or with whatever the tree happens to pass.
 */
export function profileNameOf(node: unknown): string | undefined {
    if (
        node !== null &&
        typeof node === 'object' &&
        (node as { kind?: unknown }).kind === 'profile' &&
        typeof (node as { name?: unknown }).name === 'string'
    ) {
        return (node as { name: string }).name;
    }
    return undefined;
}

export async function addProfileFlow(): Promise<void> {
    const name = await vscode.window.showInputBox({
        title: 'Add endpoint profile',
        prompt: 'Name for this endpoint, for example Production or Staging',
        validateInput: (input) =>
            input.trim().length === 0 ? 'Enter a name.' : undefined,
    });
    // Re-checked here because showInputBox stubs in tests skip validateInput.
    if (name === undefined || name.trim().length === 0) {
        return;
    }
    const url = await vscode.window.showInputBox({
        title: 'Add endpoint profile',
        prompt: `Base URL for ${name.trim()}`,
        validateInput: (input) => validateBaseUrl(input) ?? undefined,
    });
    if (url === undefined) {
        return;
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const profiles = {
        ...config.get<Record<string, string>>('profiles', {}),
        [name.trim()]: normalizeBaseUrl(url),
    };
    await config.update(
        'profiles',
        profiles,
        vscode.ConfigurationTarget.Global
    );
}

export async function removeProfileFlow(name?: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const profiles = {
        ...config.get<Record<string, string>>('profiles', {}),
    };
    let target = name;
    if (target === undefined) {
        const names = Object.keys(profiles);
        if (names.length === 0) {
            void vscode.window.showInformationMessage(
                'No endpoint profiles to remove.'
            );
            return;
        }
        target = await vscode.window.showQuickPick(names, {
            title: 'Remove endpoint profile',
            placeHolder: 'Profile to remove',
        });
        if (target === undefined) {
            return;
        }
    }
    // An unknown name is a stale click, not a fault worth an error dialog.
    if (!(target in profiles)) {
        void vscode.window.showInformationMessage(
            `No profile named ${target}.`
        );
        return;
    }
    delete profiles[target];
    await config.update(
        'profiles',
        profiles,
        vscode.ConfigurationTarget.Global
    );
}
