import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
    convertToAnthropic,
    convertToolChoice,
    convertToolsToAnthropic,
} from './anthropicMessages';

type Message = vscode.LanguageModelChatRequestMessage;

function user(...content: unknown[]): Message {
    return {
        role: vscode.LanguageModelChatMessageRole.User,
        content,
        name: undefined,
    } as Message;
}

function assistant(...content: unknown[]): Message {
    return {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content,
        name: undefined,
    } as Message;
}

const PNG = { type: 'base64', media_type: 'image/png', data: 'AQID' };

describe('convertToAnthropic', () => {
    it('maps roles and text content', () => {
        const result = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('hello')),
            assistant(new vscode.LanguageModelTextPart('hi')),
        ]);

        expect(result).toEqual({
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            ],
        });
        expect(result).not.toHaveProperty('system');
    });

    it('drops messages that carry no usable content', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('')),
            assistant(new vscode.LanguageModelTextPart('')),
            user(new vscode.LanguageModelTextPart('kept')),
        ]);

        expect(messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'kept' }] },
        ]);
    });

    it('emits an assistant tool call as a tool_use block', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('read it')),
            assistant(
                new vscode.LanguageModelTextPart('reading'),
                new vscode.LanguageModelToolCallPart('call-1', 'read_file', {
                    path: 'a.ts',
                })
            ),
        ]);

        expect(messages[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'text', text: 'reading' },
                {
                    type: 'tool_use',
                    id: 'call-1',
                    name: 'read_file',
                    input: { path: 'a.ts' },
                },
            ],
        });
    });

    it('places tool_result blocks before other user content', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('go')),
            assistant(
                new vscode.LanguageModelToolCallPart('call-1', 'read_file', {})
            ),
            user(
                new vscode.LanguageModelTextPart('now summarize'),
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('file contents'),
                ])
            ),
        ]);

        expect(messages[2]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'call-1',
                    content: [{ type: 'text', text: 'file contents' }],
                },
                { type: 'text', text: 'now summarize' },
            ],
        });
    });

    it('forwards supported tool result images and names the rest', () => {
        const { messages } = convertToAnthropic([
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('captured'),
                    vscode.LanguageModelDataPart.image(
                        new Uint8Array([1, 2, 3]),
                        'image/png'
                    ),
                    vscode.LanguageModelDataPart.image(
                        new Uint8Array([1]),
                        'image/svg+xml'
                    ),
                ])
            ),
        ]);

        expect(messages[0]?.content).toEqual([
            {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: [
                    { type: 'text', text: 'captured' },
                    { type: 'image', source: PNG },
                    { type: 'text', text: '[image: image/svg+xml]' },
                ],
            },
        ]);
    });

    it('serializes prompt-tsx, decodes text data, and keeps strings in tool results', () => {
        const value = { node: 'x', children: ['hello'] };
        const { messages } = convertToAnthropic([
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelPromptTsxPart(value),
                    vscode.LanguageModelDataPart.text('{"a":1}', 'application/json'),
                    'plain',
                    new vscode.LanguageModelDataPart(
                        new Uint8Array([0]),
                        'application/pdf'
                    ),
                ])
            ),
        ]);

        expect(messages[0]?.content).toEqual([
            {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: [
                    { type: 'text', text: JSON.stringify(value) },
                    { type: 'text', text: '{"a":1}' },
                    { type: 'text', text: 'plain' },
                ],
            },
        ]);
    });

    it('substitutes a placeholder for an empty tool result', () => {
        const { messages } = convertToAnthropic([
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart(''),
                ])
            ),
        ]);

        expect(messages[0]?.content).toEqual([
            {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: [{ type: 'text', text: '(no output)' }],
            },
        ]);
    });

    it('converts message-level data parts and drops unsupported ones', () => {
        const { messages } = convertToAnthropic([
            user(
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1, 2, 3]),
                    'image/png'
                ),
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1]),
                    'image/svg+xml'
                ),
                vscode.LanguageModelDataPart.text('from a file'),
                new vscode.LanguageModelDataPart(
                    new Uint8Array([0]),
                    'application/pdf'
                ),
                new vscode.LanguageModelDataPart(new Uint8Array([0]), 'audio/wav')
            ),
        ]);

        expect(messages[0]?.content).toEqual([
            { type: 'image', source: PNG },
            { type: 'text', text: 'from a file' },
        ]);
    });

    it('drops images from assistant turns', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('draw')),
            assistant(
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1, 2, 3]),
                    'image/png'
                ),
                new vscode.LanguageModelTextPart('done')
            ),
        ]);

        expect(messages[1]).toEqual({
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
        });
    });

    it('skips an assistant message holding only an image', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('draw')),
            assistant(
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1]),
                    'image/png'
                )
            ),
        ]);

        expect(messages).toHaveLength(1);
    });

    it('merges consecutive same-role messages', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('one')),
            user(new vscode.LanguageModelTextPart('two')),
            assistant(new vscode.LanguageModelTextPart('a')),
            assistant(new vscode.LanguageModelTextPart('b')),
        ]);

        expect(messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'one' },
                    { type: 'text', text: 'two' },
                ],
            },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'a' },
                    { type: 'text', text: 'b' },
                ],
            },
        ]);
    });

    it('keeps every tool_result first when merging user messages', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('go')),
            assistant(
                new vscode.LanguageModelToolCallPart('call-1', 'a', {}),
                new vscode.LanguageModelToolCallPart('call-2', 'b', {})
            ),
            user(
                new vscode.LanguageModelToolResultPart('call-1', ['one']),
                new vscode.LanguageModelTextPart('note')
            ),
            user(new vscode.LanguageModelToolResultPart('call-2', ['two'])),
        ]);

        expect(messages).toHaveLength(3);
        expect(messages[2]?.content).toEqual([
            {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: [{ type: 'text', text: 'one' }],
            },
            {
                type: 'tool_result',
                tool_use_id: 'call-2',
                content: [{ type: 'text', text: 'two' }],
            },
            { type: 'text', text: 'note' },
        ]);
    });

    it('merges across a skipped empty message', () => {
        const { messages } = convertToAnthropic([
            user(new vscode.LanguageModelTextPart('one')),
            assistant(new vscode.LanguageModelTextPart('')),
            user(new vscode.LanguageModelTextPart('two')),
        ]);

        expect(messages.map((message) => message.role)).toEqual(['user']);
    });

    it('prepends a placeholder user turn when history opens with the assistant', () => {
        const { messages } = convertToAnthropic([
            assistant(new vscode.LanguageModelTextPart('earlier answer')),
            user(new vscode.LanguageModelTextPart('follow up')),
        ]);

        expect(messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: '(continued)' }] },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'earlier answer' }],
            },
            { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
        ]);
    });

    it('returns no messages for an empty history', () => {
        expect(convertToAnthropic([])).toEqual({ messages: [] });
    });
});

describe('convertToolsToAnthropic', () => {
    it('returns undefined when there are no tools', () => {
        expect(convertToolsToAnthropic(undefined)).toBeUndefined();
        expect(convertToolsToAnthropic([])).toBeUndefined();
    });

    it('maps a tool to name, description, and input_schema', () => {
        const schema = { type: 'object', properties: { path: {} } };
        expect(
            convertToolsToAnthropic([
                { name: 'read_file', description: 'Read', inputSchema: schema },
            ])
        ).toEqual([
            { name: 'read_file', description: 'Read', input_schema: schema },
        ]);
    });

    it('omits an empty description', () => {
        const [tool] =
            convertToolsToAnthropic([{ name: 'now', description: '' }]) ?? [];
        expect(tool).not.toHaveProperty('description');
    });

    it('supplies an empty object schema when none is given', () => {
        const [tool] =
            convertToolsToAnthropic([
                { name: 'now', description: 'Current time' },
            ]) ?? [];
        expect(tool?.input_schema).toEqual({ type: 'object', properties: {} });
    });

    it('adds the object type to a schema that lacks one', () => {
        const [tool] =
            convertToolsToAnthropic([
                {
                    name: 'find',
                    description: 'Find',
                    inputSchema: { properties: { q: { type: 'string' } } },
                },
            ]) ?? [];
        expect(tool?.input_schema).toEqual({
            type: 'object',
            properties: { q: { type: 'string' } },
        });
    });
});

describe('convertToolChoice', () => {
    it('maps Required to any and everything else to auto', () => {
        expect(
            convertToolChoice(vscode.LanguageModelChatToolMode.Required)
        ).toEqual({ type: 'any' });
        expect(
            convertToolChoice(vscode.LanguageModelChatToolMode.Auto)
        ).toEqual({ type: 'auto' });
        expect(convertToolChoice(undefined)).toEqual({ type: 'auto' });
    });
});
