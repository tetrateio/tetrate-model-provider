import * as vscode from 'vscode';

export const API_KEY_SECRET = 'tetrate-model-provider.agentRouterApiKey';

export async function getApiKey(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    return apiKey?.trim() ? apiKey.trim() : undefined;
}

export async function storeApiKey(
    context: vscode.ExtensionContext,
    apiKey: string
): Promise<void> {
    await context.secrets.store(API_KEY_SECRET, apiKey.trim());
}

export async function deleteApiKey(
    context: vscode.ExtensionContext
): Promise<void> {
    await context.secrets.delete(API_KEY_SECRET);
}

/**
 * Asks for the Agent Router API key and stores it. Returns undefined when the
 * user dismisses the prompt, which is a normal outcome rather than an error.
 */
export async function promptForApiKey(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    const apiKey = await vscode.window.showInputBox({
        title: 'Tetrate Agent Router',
        prompt: 'Enter your Agent Router API key',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
            value.trim().length === 0
                ? 'The Agent Router API key must not be empty.'
                : undefined,
    });

    if (!apiKey?.trim()) {
        return undefined;
    }

    await storeApiKey(context, apiKey);
    return apiKey.trim();
}
