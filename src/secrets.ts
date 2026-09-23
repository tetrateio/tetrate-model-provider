import * as vscode from 'vscode';

/**
 * Legacy secret name from versions that stored one key for every endpoint,
 * and the prefix every per-host name starts with. Kept as a read fallback so
 * an upgrade does not sign anyone out.
 */
export const API_KEY_SECRET = 'tetrate-model-provider.agentRouterApiKey';

/**
 * Keys are stored per endpoint host. Switching the base URL between the
 * hosted service and a self-hosted deployment previously sent whichever key
 * was stored to whichever host was configured; scoping the secret to the host
 * keeps each credential where it belongs.
 */
export function apiKeySecretName(baseUrl: string): string {
    return `${API_KEY_SECRET}:${hostOf(baseUrl)}`;
}

/**
 * The scoping unit is the host (with port), not the full URL: two paths on
 * one gateway share a credential, while two hosts never do. A base URL that
 * does not parse falls back to its own text, which still scopes correctly.
 */
function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).host.toLowerCase();
    } catch {
        return baseUrl.trim().toLowerCase();
    }
}

export async function getApiKey(
    context: vscode.ExtensionContext,
    baseUrl: string
): Promise<string | undefined> {
    const scoped = await context.secrets.get(apiKeySecretName(baseUrl));
    if (scoped?.trim()) {
        return scoped.trim();
    }
    // A key stored by a version before per-host scoping. It was sent to every
    // configured host then, so serving it for this one changes nothing until
    // a scoped key is stored.
    const legacy = await context.secrets.get(API_KEY_SECRET);
    return legacy?.trim() ? legacy.trim() : undefined;
}

export async function storeApiKey(
    context: vscode.ExtensionContext,
    baseUrl: string,
    apiKey: string
): Promise<void> {
    await context.secrets.store(apiKeySecretName(baseUrl), apiKey.trim());
}

/**
 * Removes the key for this endpoint. The legacy unscoped key is removed too:
 * leaving it would resurrect the just-cleared credential through the read
 * fallback, which is the opposite of what "clear" promised.
 */
export async function deleteApiKey(
    context: vscode.ExtensionContext,
    baseUrl: string
): Promise<void> {
    await context.secrets.delete(apiKeySecretName(baseUrl));
    await context.secrets.delete(API_KEY_SECRET);
}

/**
 * Asks for the Agent Router API key and stores it for the given endpoint.
 * Returns undefined when the user dismisses the prompt, which is a normal
 * outcome rather than an error.
 */
export async function promptForApiKey(
    context: vscode.ExtensionContext,
    baseUrl: string
): Promise<string | undefined> {
    const apiKey = await vscode.window.showInputBox({
        title: 'Tetrate Agent Router',
        prompt: `Enter your Agent Router API key for ${hostOf(baseUrl)}. Keys are created in the dashboard at router.tetrate.ai.`,
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

    await storeApiKey(context, baseUrl, apiKey);
    return apiKey.trim();
}
