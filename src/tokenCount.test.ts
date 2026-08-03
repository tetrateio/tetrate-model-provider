import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
    countTokens,
    estimateTextTokens,
    TOKENS_PER_IMAGE,
    TOKENS_PER_MESSAGE,
} from './tokenCount';

describe('estimateTextTokens', () => {
    it('is zero for empty text and rounds up otherwise', () => {
        expect(estimateTextTokens('')).toBe(0);
        expect(estimateTextTokens('abcd')).toBe(2); // ceil(4 / 3.5)
    });

    it('grows with input length', () => {
        expect(estimateTextTokens('a'.repeat(350))).toBe(100);
        expect(estimateTextTokens('a'.repeat(700))).toBe(200);
    });
});

describe('countTokens', () => {
    it('counts a bare string without message overhead', () => {
        expect(countTokens('a'.repeat(350))).toBe(100);
    });

    it('adds per-message overhead for a message', () => {
        const message = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart('a'.repeat(350))],
            name: undefined,
        } as vscode.LanguageModelChatRequestMessage;

        expect(countTokens(message)).toBe(TOKENS_PER_MESSAGE + 100);
    });

    it('charges a flat cost for images and counts nested tool results', () => {
        const message = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1, 2, 3]),
                    'image/png'
                ),
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('a'.repeat(350)),
                ]),
            ],
            name: undefined,
        } as vscode.LanguageModelChatRequestMessage;

        expect(countTokens(message)).toBe(
            TOKENS_PER_MESSAGE + TOKENS_PER_IMAGE + 100
        );
    });

    it('counts a tool call name and its arguments', () => {
        const message = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [
                new vscode.LanguageModelToolCallPart('call-1', 'read_file', {
                    path: 'a.ts',
                }),
            ],
            name: undefined,
        } as vscode.LanguageModelChatRequestMessage;

        expect(countTokens(message)).toBeGreaterThan(TOKENS_PER_MESSAGE);
    });
});
