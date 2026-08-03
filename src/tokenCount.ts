import * as vscode from 'vscode';

/**
 * The Agent Router exposes no token-counting route, and the models behind it
 * span three different tokenizers, so counts are estimated locally.
 *
 * ~4 chars/token holds for prose but drops to ~2.5 on dense source code.
 * Estimating low would let a caller overfill its budget and get a hard API
 * error, so the divisor is deliberately pessimistic: overcounting only leaves
 * some context unused.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Per-message protocol overhead (role, delimiters) in the OpenAI encoding. */
export const TOKENS_PER_MESSAGE = 4;

/**
 * A modest flat cost for an image. Real cost scales with resolution, which is
 * not available here without decoding the image.
 */
export const TOKENS_PER_IMAGE = 800;

export function countTokens(
    text: string | vscode.LanguageModelChatRequestMessage
): number {
    if (typeof text === 'string') {
        return estimateTextTokens(text);
    }
    return TOKENS_PER_MESSAGE + countContentTokens(text.content);
}

export function countContentTokens(parts: ReadonlyArray<unknown>): number {
    let tokens = 0;

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            tokens += estimateTextTokens(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            tokens +=
                estimateTextTokens(part.name) +
                estimateTextTokens(safeStringify(part.input));
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            tokens += countContentTokens(part.content);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            tokens += part.mimeType.startsWith('image/')
                ? TOKENS_PER_IMAGE
                : estimateTextTokens(
                      new TextDecoder().decode(part.data)
                  );
        } else if (typeof part === 'string') {
            tokens += estimateTextTokens(part);
        }
    }

    return tokens;
}

export function estimateTextTokens(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value ?? {}) ?? '';
    } catch {
        return '';
    }
}
