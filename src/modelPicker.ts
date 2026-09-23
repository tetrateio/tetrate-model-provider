import * as vscode from 'vscode';

import { isIncludedByFilter } from './config';
import { formatTokens } from './usage';

/**
 * The Choose Models quick pick. The hosted catalog is past 160 conversational
 * models, so a flat checkbox list stopped being navigable: items are grouped
 * under provider separators, capability icons mark tool and vision support at
 * a glance, and two title buttons select or clear everything at once.
 */

export type ModelPickItem = vscode.QuickPickItem & { id?: string };

/**
 * Builds the pick list: models grouped by family with a separator per group,
 * capability codicons in the label, and the context window alongside the
 * price in the detail line. Families are ordered alphabetically and models by
 * display name within each, so related models sit together instead of being
 * scattered by their id spelling.
 */
export function buildModelPickItems(
    models: readonly vscode.LanguageModelChatInformation[],
    filter: string[]
): ModelPickItem[] {
    const byFamily = new Map<string, vscode.LanguageModelChatInformation[]>();
    for (const model of models) {
        const family = model.family || 'other';
        const group = byFamily.get(family) ?? [];
        group.push(model);
        byFamily.set(family, group);
    }

    const items: ModelPickItem[] = [];
    for (const family of [...byFamily.keys()].sort((a, b) =>
        a.localeCompare(b)
    )) {
        items.push({
            label: family,
            kind: vscode.QuickPickItemKind.Separator,
        });
        const group = byFamily.get(family) ?? [];
        group.sort((a, b) => a.name.localeCompare(b.name));
        for (const model of group) {
            items.push({
                label: `${capabilityIcons(model)}${model.name}`,
                description: model.id,
                detail: `${model.detail ?? 'Agent Router'} · ${formatContext(model)} context`,
                picked: isIncludedByFilter(model.id, filter),
                id: model.id,
            });
        }
    }
    return items;
}

/** `$(tools)` for tool calling, `$(eye)` for image input; both render natively. */
function capabilityIcons(
    model: vscode.LanguageModelChatInformation
): string {
    const icons = [
        ...(model.capabilities?.toolCalling ? ['$(tools)'] : []),
        ...(model.capabilities?.imageInput ? ['$(eye)'] : []),
    ];
    return icons.length > 0 ? `${icons.join(' ')} ` : '';
}

/** The whole window the model works with: input and output budgets combined. */
export function formatContext(
    model: Pick<
        vscode.LanguageModelChatInformation,
        'maxInputTokens' | 'maxOutputTokens'
    >
): string {
    const total = model.maxInputTokens + model.maxOutputTokens;
    if (total >= 1_000_000 && total % 100_000 === 0) {
        return `${total / 1_000_000}M`;
    }
    if (total >= 10_000) {
        return `${Math.round(total / 1000)}K`;
    }
    return formatTokens(total);
}

/**
 * Runs the pick and resolves with the selected ids, or undefined when the
 * user dismissed it. Built on `createQuickPick` rather than `showQuickPick`
 * because only the former offers title buttons for select-all and clear.
 */
export function pickModels(
    models: readonly vscode.LanguageModelChatInformation[],
    filter: string[]
): Promise<string[] | undefined> {
    const items = buildModelPickItems(models, filter);
    const selectable = items.filter((item) => item.id !== undefined);

    const selectAll: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check-all'),
        tooltip: 'Select all models',
    };
    const selectNone: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('clear-all'),
        tooltip: 'Clear the selection',
    };

    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick<ModelPickItem>();
        picker.title = 'Tetrate Agent Router: models to offer';
        picker.placeholder =
            'The selection replaces the modelFilter setting; selecting everything clears it.';
        picker.canSelectMany = true;
        picker.matchOnDescription = true;
        picker.buttons = [selectAll, selectNone];
        picker.items = items;
        picker.selectedItems = selectable.filter((item) => item.picked);

        let settled = false;
        const settle = (value: string[] | undefined) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
            picker.dispose();
        };

        picker.onDidTriggerButton((button) => {
            picker.selectedItems = button === selectAll ? selectable : [];
        });
        picker.onDidAccept(() => {
            settle(
                picker.selectedItems
                    .map((item) => item.id)
                    .filter((id): id is string => id !== undefined)
            );
        });
        picker.onDidHide(() => {
            settle(undefined);
        });
        picker.show();
    });
}
