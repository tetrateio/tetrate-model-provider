import * as vscode from 'vscode';

/**
 * The status-bar command center: one quick pick that gathers every command the
 * extension registers, so the status bar item can open a single menu instead
 * of forcing a trip through the command palette for each action.
 */

export type CommandCenterItem = vscode.QuickPickItem & { commandId?: string };

/** Everything the menu shows comes in as strings; no lookups happen here. */
type CommandCenterState = {
    baseUrl: string;
    profileName?: string;
    sessionHeadline: string;
    todayCost: string;
};

const COMMAND_PREFIX = 'tetrate-model-provider.';

/**
 * Builds the menu. The leading separator names the active endpoint — the
 * profile name when one is selected, since that is how the user thinks of it,
 * and the bare URL otherwise. Day-to-day actions come first; the ones only
 * needed while setting up sit under their own separator.
 */
export function buildCommandCenterItems(
    state: CommandCenterState
): CommandCenterItem[] {
    return [
        {
            label: state.profileName ?? state.baseUrl,
            kind: vscode.QuickPickItemKind.Separator,
        },
        {
            label: '$(graph) Open usage dashboard',
            description: `${state.todayCost} today · ${state.sessionHeadline} this session`,
            commandId: `${COMMAND_PREFIX}showUsage`,
        },
        {
            label: '$(checklist) Choose models',
            commandId: `${COMMAND_PREFIX}chooseModels`,
        },
        {
            label: '$(globe) Switch endpoint',
            description: state.baseUrl,
            commandId: `${COMMAND_PREFIX}switchEndpoint`,
        },
        {
            label: '$(refresh) Refresh model list',
            commandId: `${COMMAND_PREFIX}refreshModels`,
        },
        {
            label: 'Setup',
            kind: vscode.QuickPickItemKind.Separator,
        },
        {
            label: '$(key) Set API key',
            commandId: `${COMMAND_PREFIX}setApiKey`,
        },
        {
            label: '$(beaker) Test connection',
            commandId: `${COMMAND_PREFIX}testConnection`,
        },
        {
            label: '$(pulse) Connection status',
            commandId: `${COMMAND_PREFIX}showStatus`,
        },
    ];
}

/**
 * Shows the menu and runs the chosen command. Dispatching through
 * `executeCommand` rather than calling into the extension keeps this module
 * free of every dependency those commands carry.
 */
export async function showCommandCenter(
    state: CommandCenterState
): Promise<void> {
    const picked = await vscode.window.showQuickPick(
        buildCommandCenterItems(state),
        {
            title: 'Tetrate Agent Router',
            // Descriptions carry the cost figures and the endpoint URL, which
            // are as likely to be typed as the labels.
            matchOnDescription: true,
        }
    );
    if (picked?.commandId) {
        await vscode.commands.executeCommand(picked.commandId);
    }
}
