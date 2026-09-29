import type Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlock = Anthropic.Messages.ContentBlockParam;
type TextBlock = Anthropic.Messages.TextBlockParam;
type ImageBlock = Anthropic.Messages.ImageBlockParam;
type ImageMediaType = Anthropic.Messages.Base64ImageSource['media_type'];
type ToolResultContent = TextBlock | ImageBlock;

export type AnthropicConversation = {
    /**
     * Reserved for a system prompt. VS Code's provider API has only User and
     * Assistant roles, and a system prompt arrives as ordinary user content
     * with nothing marking it as such. Guessing would move user text into a
     * slot the model weighs differently, so this is left unset for now.
     */
    system?: string;
    messages: MessageParam[];
};

/**
 * The image formats the Messages API accepts in a base64 source. Anything
 * else (SVG, BMP, ...) is a hard API error, so it is never sent as an image.
 */
const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);

/**
 * Stands in for the first user turn when the history opens with an assistant
 * message. The API requires the conversation to start with a user turn;
 * a neutral placeholder keeps the request valid without discarding the
 * assistant's earlier output.
 */
const CONTINUATION_PLACEHOLDER = '(continued)';

/**
 * Rewrites VS Code's chat history as Anthropic Messages API turns.
 *
 * Unlike the OpenAI protocol, tool results stay inside the user turn as
 * `tool_result` blocks, so VS Code's shape maps almost directly. Two API rules
 * drive the rest of this function: turns must strictly alternate starting with
 * a user turn, and within a user turn every `tool_result` block must precede
 * any other content. Consecutive same-role messages are therefore merged, and
 * tool results are sorted to the front of each merged user turn.
 *
 * Tool calls without a matching result are passed through untouched; pairing
 * them is the caller's responsibility, and inventing results would mislead
 * the model.
 */
export function convertToAnthropic(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): AnthropicConversation {
    const turns: MessageParam[] = [];

    for (const message of messages) {
        const isAssistant =
            message.role === vscode.LanguageModelChatMessageRole.Assistant;
        const blocks = isAssistant
            ? convertAssistantContent(message.content)
            : convertUserContent(message.content);

        if (blocks.length === 0) {
            continue;
        }

        const role = isAssistant ? 'assistant' : 'user';
        const previous = turns[turns.length - 1];
        if (previous && previous.role === role) {
            previous.content = [...asBlocks(previous.content), ...blocks];
        } else {
            turns.push({ role, content: blocks });
        }
    }

    for (const turn of turns) {
        if (turn.role === 'user') {
            turn.content = toolResultsFirst(asBlocks(turn.content));
        }
    }

    if (turns[0]?.role === 'assistant') {
        turns.unshift({
            role: 'user',
            content: [{ type: 'text', text: CONTINUATION_PLACEHOLDER }],
        });
    }

    return { messages: turns };
}

/**
 * Assistant turns carry text and `tool_use` blocks. Images are not accepted in
 * an assistant turn, and a tool result there has no valid encoding, so both
 * are dropped rather than sent as a shape the API rejects.
 */
function convertAssistantContent(
    parts: ReadonlyArray<unknown>
): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            if (part.value.length > 0) {
                blocks.push({ type: 'text', text: part.value });
            }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            blocks.push({
                type: 'tool_use',
                id: part.callId,
                name: part.name,
                input: part.input ?? {},
            });
        } else if (part instanceof vscode.LanguageModelDataPart) {
            const converted = convertDataPart(part);
            if (converted?.type === 'text') {
                blocks.push(converted);
            }
        }
    }

    return blocks;
}

/**
 * User turns carry text, images and `tool_result` blocks. A tool call in a
 * user message has no valid encoding and is dropped.
 */
function convertUserContent(parts: ReadonlyArray<unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            if (part.value.length > 0) {
                blocks.push({ type: 'text', text: part.value });
            }
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            blocks.push({
                type: 'tool_result',
                tool_use_id: part.callId,
                content: convertToolResultContent(part.content),
            });
        } else if (part instanceof vscode.LanguageModelDataPart) {
            const converted = convertDataPart(part);
            if (converted) {
                blocks.push(converted);
            }
        }
    }

    return blocks;
}

/**
 * A `tool_result` accepts text and image blocks, so tool output keeps its
 * structure instead of being flattened to one string. Images in a format the
 * API cannot take are named in text so they never vanish silently.
 */
function convertToolResultContent(
    parts: ReadonlyArray<unknown>
): ToolResultContent[] {
    const content: ToolResultContent[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            pushText(content, part.value);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            if (part.mimeType.startsWith('image/')) {
                const image = toImageBlock(part);
                if (image) {
                    content.push(image);
                } else {
                    pushText(content, `[image: ${part.mimeType}]`);
                }
            } else if (isTextMime(part.mimeType)) {
                pushText(content, decodeText(part.data));
            }
        } else if (part instanceof vscode.LanguageModelPromptTsxPart) {
            // VS Code's built-in tools return rendered prompt-tsx trees. The
            // model cannot consume the tree directly, but its JSON form still
            // carries the text inside it, which beats dropping the result.
            pushText(content, safeStringify(part.value));
        } else if (typeof part === 'string') {
            pushText(content, part);
        }
    }

    // An empty result is a normal outcome worth reporting as such, and it
    // avoids sending a tool_result the model could read as a lost response.
    return content.length > 0 ? content : [{ type: 'text', text: '(no output)' }];
}

/**
 * Converts a message-level data part. Unsupported image formats, audio and
 * PDF are left out, matching the OpenAI conversion in messages.ts.
 */
function convertDataPart(
    part: vscode.LanguageModelDataPart
): TextBlock | ImageBlock | undefined {
    if (part.mimeType.startsWith('image/')) {
        return toImageBlock(part);
    }

    if (isTextMime(part.mimeType)) {
        const text = decodeText(part.data);
        return text.length > 0 ? { type: 'text', text } : undefined;
    }

    return undefined;
}

function toImageBlock(
    part: vscode.LanguageModelDataPart
): ImageBlock | undefined {
    if (!SUPPORTED_IMAGE_TYPES.has(part.mimeType)) {
        return undefined;
    }

    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: part.mimeType as ImageMediaType,
            data: Buffer.from(part.data).toString('base64'),
        },
    };
}

/**
 * Stable partition: `tool_result` blocks move to the front, everything else
 * keeps its relative order. Needed after merging, where a later message's
 * tool results would otherwise follow an earlier message's text.
 */
function toolResultsFirst(blocks: ContentBlock[]): ContentBlock[] {
    return [
        ...blocks.filter((block) => block.type === 'tool_result'),
        ...blocks.filter((block) => block.type !== 'tool_result'),
    ];
}

function asBlocks(content: MessageParam['content']): ContentBlock[] {
    return typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : content;
}

function pushText(content: ToolResultContent[], text: string): void {
    // The API rejects empty text blocks.
    if (text.length > 0) {
        content.push({ type: 'text', text });
    }
}

export function convertToolsToAnthropic(
    tools: readonly vscode.LanguageModelChatTool[] | undefined
): Anthropic.Messages.Tool[] | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: toInputSchema(tool.inputSchema),
    }));
}

/**
 * The API requires `input_schema.type` to be `'object'`. VS Code tools may
 * omit a schema or its `type` when they take no or loosely described input,
 * so the object type is filled in. A schema declaring some other type is
 * passed through as-is; rewriting it would silently change its meaning.
 */
function toInputSchema(
    schema: object | undefined
): Anthropic.Messages.Tool.InputSchema {
    if (!schema) {
        return { type: 'object', properties: {} };
    }

    const record = schema as Record<string, unknown>;
    return (
        'type' in record ? record : { type: 'object', ...record }
    ) as Anthropic.Messages.Tool.InputSchema;
}

export function convertToolChoice(
    mode: vscode.LanguageModelChatToolMode | undefined
): Anthropic.Messages.ToolChoice {
    return mode === vscode.LanguageModelChatToolMode.Required
        ? { type: 'any' }
        : { type: 'auto' };
}

function isTextMime(mimeType: string): boolean {
    return mimeType.startsWith('text/') || mimeType === 'application/json';
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
