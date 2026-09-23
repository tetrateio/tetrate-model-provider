import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
    countTokens,
    estimateBinaryTokens,
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

describe('estimateBinaryTokens', () => {
    it('is zero for empty data and rounds up otherwise', () => {
        expect(estimateBinaryTokens(new Uint8Array(0))).toBe(0);
        expect(estimateBinaryTokens(new Uint8Array(4))).toBe(2);
    });

    it('never undercounts multi-byte text', () => {
        // Measuring bytes rather than decoding is the point; where the two
        // differ the byte count is the larger, which is the safe direction.
        const text = '→'.repeat(100); // three bytes each
        const data = new TextEncoder().encode(text);
        expect(estimateBinaryTokens(data)).toBeGreaterThanOrEqual(
            estimateTextTokens(text)
        );
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

    it('measures a non-image data part without decoding it', () => {
        const message = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [
                vscode.LanguageModelDataPart.text('a'.repeat(350), 'text/plain'),
            ],
            name: undefined,
        } as vscode.LanguageModelChatRequestMessage;

        expect(countTokens(message)).toBe(TOKENS_PER_MESSAGE + 100);
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

    it('counts a prompt-tsx tool result by its JSON form', () => {
        const value = { node: 'x', children: ['hello'] };
        const message = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelPromptTsxPart(value),
                ]),
            ],
            name: undefined,
        } as vscode.LanguageModelChatRequestMessage;

        expect(countTokens(message)).toBeGreaterThan(TOKENS_PER_MESSAGE);
        expect(countTokens(message)).toBe(
            TOKENS_PER_MESSAGE + estimateTextTokens(JSON.stringify(value))
        );
    });
});
