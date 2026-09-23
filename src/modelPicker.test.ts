import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
    buildModelPickItems,
    formatContext,
    type ModelPickItem,
    pickModels,
} from './modelPicker';

function model(
    partial: Partial<vscode.LanguageModelChatInformation> & { id: string }
): vscode.LanguageModelChatInformation {
    return {
        name: partial.id,
        family: 'other',
        version: '1.0',
        maxInputTokens: 100_000,
        maxOutputTokens: 28_000,
        capabilities: {},
        ...partial,
    } as vscode.LanguageModelChatInformation;
}

const models = [
    model({
        id: 'gpt-5-mini',
        name: 'GPT-5 mini',
        family: 'openai',
        capabilities: { toolCalling: true },
    }),
    model({
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        family: 'anthropic',
        detail: 'Agent Router · anthropic · $2/$10 per 1M',
        maxInputTokens: 872_000,
        maxOutputTokens: 128_000,
        capabilities: { toolCalling: true, imageInput: true },
    }),
    model({
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        family: 'anthropic',
    }),
];

describe('buildModelPickItems', () => {
    it('groups models under family separators, alphabetically', () => {
        const items = buildModelPickItems(models, []);

        expect(
            items.map((item) =>
                item.kind === vscode.QuickPickItemKind.Separator
                    ? `-- ${item.label}`
                    : item.id
            )
        ).toEqual([
            '-- anthropic',
            'claude-haiku-4-5',
            'claude-opus-5',
            '-- openai',
            'gpt-5-mini',
        ]);
    });

    it('marks capabilities with codicons and keeps the id searchable', () => {
        const items = buildModelPickItems(models, []);
        const opus = items.find((item) => item.id === 'claude-opus-5');
        const haiku = items.find((item) => item.id === 'claude-haiku-4-5');

        expect(opus?.label).toBe('$(tools) $(eye) Claude Opus 5');
        expect(opus?.description).toBe('claude-opus-5');
        expect(haiku?.label).toBe('Claude Haiku 4.5');
    });

    it('appends the context window to the detail line', () => {
        const items = buildModelPickItems(models, []);
        const opus = items.find((item) => item.id === 'claude-opus-5');

        expect(opus?.detail).toBe(
            'Agent Router · anthropic · $2/$10 per 1M · 1M context'
        );
    });

    it('pre-selects models the current filter includes', () => {
        const items = buildModelPickItems(models, ['claude-*']);

        expect(
            items
                .filter((item) => item.picked)
                .map((item) => item.id)
                .sort()
        ).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
        expect(
            items.find((item) => item.id === 'gpt-5-mini')?.picked
        ).toBe(false);
    });
});

describe('formatContext', () => {
    it('rounds to the readable unit', () => {
        expect(
            formatContext({ maxInputTokens: 872_000, maxOutputTokens: 128_000 })
        ).toBe('1M');
        expect(
            formatContext({ maxInputTokens: 100_000, maxOutputTokens: 28_000 })
        ).toBe('128K');
        expect(
            formatContext({ maxInputTokens: 4096, maxOutputTokens: 4096 })
        ).toBe('8,192');
    });
});

type MockPicker = {
    items: ModelPickItem[];
    selectedItems: ModelPickItem[];
    buttons: vscode.QuickInputButton[];
    _accept(): void;
    _hide(): void;
    _button(button: unknown): void;
};

function openPicker(filter: string[] = []) {
    let picker: MockPicker | undefined;
    const original = vscode.window.createQuickPick;
    (vscode.window as { createQuickPick: unknown }).createQuickPick = () => {
        picker = (original as unknown as () => MockPicker)();
        return picker;
    };
    const pending = pickModels(models, filter);
    (vscode.window as { createQuickPick: unknown }).createQuickPick = original;
    if (!picker) {
        throw new Error('createQuickPick was not called');
    }
    return { pending, picker };
}

describe('pickModels', () => {
    it('resolves with the accepted ids', async () => {
        const { pending, picker } = openPicker(['claude-opus-5']);
        expect(picker.selectedItems.map((item) => item.id)).toEqual([
            'claude-opus-5',
        ]);

        picker.selectedItems = picker.items.filter(
            (item) => item.id === 'gpt-5-mini'
        );
        picker._accept();

        await expect(pending).resolves.toEqual(['gpt-5-mini']);
    });

    it('resolves undefined when dismissed', async () => {
        const { pending, picker } = openPicker();
        picker._hide();
        await expect(pending).resolves.toBeUndefined();
    });

    it('selects everything and nothing from the title buttons', async () => {
        const { pending, picker } = openPicker();

        picker._button(picker.buttons[0]);
        expect(picker.selectedItems.map((item) => item.id).sort()).toEqual([
            'claude-haiku-4-5',
            'claude-opus-5',
            'gpt-5-mini',
        ]);

        picker._button(picker.buttons[1]);
        expect(picker.selectedItems).toEqual([]);

        picker._hide();
        await pending;
    });
});
