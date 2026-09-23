import type OpenAI from 'openai';
import * as vscode from 'vscode';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type ToolCall =
    OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export type ConvertOptions = {
    /**
     * Forward images found in tool results to the model. A `tool` message is
     * text-only in the OpenAI protocol, so the images travel in the user
     * message that follows it; the tool text marks where each one came from.
     * Only set for models that accept image input, since sending an image to
     * a text-only model is a hard API error.
     */
    toolResultImages?: boolean;
};

/**
 * Rewrites VS Code's chat history as OpenAI chat-completion messages.
 *
 * The two models differ in where tool results live: VS Code attaches a
 * {@link vscode.LanguageModelToolResultPart} to a user message, while the
 * OpenAI protocol wants a standalone `tool` message that follows the assistant
 * turn requesting it. Tool results are therefore emitted before the rest of the
 * user content, which preserves the assistant → tool → user ordering the API
 * validates.
 */
export function convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ConvertOptions = {}
): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const message of messages) {
        const isAssistant =
            message.role === vscode.LanguageModelChatMessageRole.Assistant;
        const content: ContentPart[] = [];
        const toolCalls: ToolCall[] = [];

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value.length > 0) {
                    content.push({ type: 'text', text: part.value });
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.input ?? {}),
                    },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const flattened = flattenToolResult(
                    part.content,
                    options.toolResultImages === true
                );
                result.push({
                    role: 'tool',
                    tool_call_id: part.callId,
                    content: flattened.text,
                });
                // Hoisted images join the user content assembled below, which
                // is pushed after every tool message of this VS Code message,
                // so the ordering the API validates is preserved.
                content.push(...flattened.images);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                const converted = convertDataPart(part);
                if (converted) {
                    content.push(converted);
                }
            }
        }

        if (isAssistant) {
            if (content.length === 0 && toolCalls.length === 0) {
                continue;
            }
            result.push({
                role: 'assistant',
                // An assistant turn that only calls tools must omit content
                // rather than send an empty string.
                ...(content.length > 0 ? { content: toText(content) } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            });
        } else if (content.length > 0) {
            result.push({
                role: 'user',
                content,
                ...(message.name ? { name: message.name } : {}),
            });
        }
    }

    return result;
}

/**
 * Assistant content is text-only in the OpenAI protocol, so image parts in a
 * replayed assistant turn are dropped rather than sent as an invalid shape.
 */
function toText(content: ContentPart[]): string {
    return content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter((text) => text.length > 0)
        .join('\n');
}

type FlattenedToolResult = {
    text: string;
    /** Image parts to carry in the user message that follows; see convertMessages. */
    images: ContentPart[];
};

/**
 * A `tool` message carries plain text. Images returned by a tool are hoisted
 * into the next user message when the model accepts them, and are named in
 * the text either way, so they never vanish silently.
 */
function flattenToolResult(
    parts: ReadonlyArray<unknown>,
    withImages: boolean
): FlattenedToolResult {
    const chunks: string[] = [];
    const images: ContentPart[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            chunks.push(part.value);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            if (part.mimeType.startsWith('image/')) {
                const converted = withImages ? convertDataPart(part) : undefined;
                if (converted) {
                    images.push(converted);
                    chunks.push(
                        `[image: ${part.mimeType}, attached to the next user message]`
                    );
                } else {
                    chunks.push(`[image: ${part.mimeType}]`);
                }
            } else {
                chunks.push(decodeText(part.data));
            }
        } else if (part instanceof vscode.LanguageModelPromptTsxPart) {
            // VS Code's built-in tools return rendered prompt-tsx trees. The
            // model cannot consume the tree directly, but its JSON form still
            // carries the text inside it, which beats dropping the result.
            chunks.push(safeStringify(part.value));
        } else if (typeof part === 'string') {
            chunks.push(part);
        }
    }

    const text = chunks.filter((chunk) => chunk.length > 0).join('\n');
    // The API rejects a tool message with empty content, and a tool that
    // returned nothing is a normal outcome worth reporting as such.
    return { text: text.length > 0 ? text : '(no output)', images };
}

export function convertDataPart(
    part: vscode.LanguageModelDataPart
): ContentPart | undefined {
    if (part.mimeType.startsWith('image/')) {
        const base64 = Buffer.from(part.data).toString('base64');
        return {
            type: 'image_url',
            image_url: { url: `data:${part.mimeType};base64,${base64}` },
        };
    }

    if (
        part.mimeType.startsWith('text/') ||
        part.mimeType === 'application/json'
    ) {
        const text = decodeText(part.data);
        return text.length > 0 ? { type: 'text', text } : undefined;
    }

    // Audio and PDF inputs are not part of the chat-completions content model
    // this endpoint exposes, so they are left out.
    return undefined;
}

export function convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined
): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: (tool.inputSchema as Record<string, unknown>) ?? {
                type: 'object',
                properties: {},
            },
        },
    }));
}

export function convertToolMode(
    mode: vscode.LanguageModelChatToolMode | undefined
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
    return mode === vscode.LanguageModelChatToolMode.Required
        ? 'required'
        : 'auto';
}

function decodeText(data: Uint8Array): string {
    return new TextDecoder().decode(data);
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value ?? {}) ?? '';
    } catch {
        return '';
    }
}
