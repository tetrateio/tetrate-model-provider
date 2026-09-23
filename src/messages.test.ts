import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { convertMessages, convertToolMode, convertTools } from './messages';

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

describe('convertMessages', () => {
    it('maps roles and text content', () => {
        const result = convertMessages([
            user(new vscode.LanguageModelTextPart('hello')),
            assistant(new vscode.LanguageModelTextPart('hi')),
        ]);

        expect(result).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            { role: 'assistant', content: 'hi' },
        ]);
    });

    it('drops messages that carry no usable content', () => {
        const result = convertMessages([
            user(new vscode.LanguageModelTextPart('')),
            assistant(new vscode.LanguageModelTextPart('')),
            user(new vscode.LanguageModelTextPart('kept')),
        ]);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ role: 'user' });
    });

    it('emits an assistant tool call without a content field', () => {
        const result = convertMessages([
            assistant(
                new vscode.LanguageModelToolCallPart('call-1', 'read_file', {
                    path: 'a.ts',
                })
            ),
        ]);

        expect(result).toEqual([
            {
                role: 'assistant',
                tool_calls: [
                    {
                        id: 'call-1',
                        type: 'function',
                        function: {
                            name: 'read_file',
                            arguments: '{"path":"a.ts"}',
                        },
                    },
                ],
            },
        ]);
        expect(result[0]).not.toHaveProperty('content');
    });

    it('turns a tool result into a tool message ordered before user text', () => {
        const result = convertMessages([
            assistant(
                new vscode.LanguageModelToolCallPart('call-1', 'read_file', {})
            ),
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('file contents'),
                ]),
                new vscode.LanguageModelTextPart('now summarize')
            ),
        ]);

        expect(result.map((message) => message.role)).toEqual([
            'assistant',
            'tool',
            'user',
        ]);
        expect(result[1]).toEqual({
            role: 'tool',
            tool_call_id: 'call-1',
            content: 'file contents',
        });
    });

    it('substitutes a placeholder for an empty tool result', () => {
        const result = convertMessages([
            user(new vscode.LanguageModelToolResultPart('call-1', [])),
        ]);

        expect(result).toEqual([
            { role: 'tool', tool_call_id: 'call-1', content: '(no output)' },
        ]);
    });

    it('serializes a prompt-tsx tool result as JSON text', () => {
        const value = { node: 'x', children: ['hello'] };
        const result = convertMessages([
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelPromptTsxPart(value),
                ])
            ),
        ]);

        expect(result).toEqual([
            {
                role: 'tool',
                tool_call_id: 'call-1',
                content: JSON.stringify(value),
            },
        ]);
    });

    it('joins text and prompt-tsx tool result parts in order', () => {
        const value = { node: 'x', children: ['hello'] };
        const result = convertMessages([
            user(
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('before'),
                    new vscode.LanguageModelPromptTsxPart(value),
                    new vscode.LanguageModelTextPart('after'),
                ])
            ),
        ]);

        expect(result[0]).toEqual({
            role: 'tool',
            tool_call_id: 'call-1',
            content: ['before', JSON.stringify(value), 'after'].join('\n'),
        });
    });

    it('encodes an image part as a data URL', () => {
        const result = convertMessages([
            user(
                vscode.LanguageModelDataPart.image(
                    new Uint8Array([1, 2, 3]),
                    'image/png'
                )
            ),
        ]);

        expect(result[0]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,AQID' },
                },
            ],
        });
    });

    it('keeps text data parts and ignores unsupported binary types', () => {
        const result = convertMessages([
            user(
                vscode.LanguageModelDataPart.text('from a file'),
                new vscode.LanguageModelDataPart(
                    new Uint8Array([0]),
                    'application/pdf'
                )
            ),
        ]);

        expect(result[0]?.content).toEqual([
            { type: 'text', text: 'from a file' },
        ]);
    });

    it('joins multiple assistant text parts', () => {
        const result = convertMessages([
            assistant(
                new vscode.LanguageModelTextPart('one'),
                new vscode.LanguageModelTextPart('two')
            ),
        ]);

        expect(result[0]).toEqual({ role: 'assistant', content: 'one\ntwo' });
    });
});

describe('convertTools', () => {
    it('returns undefined when there are no tools', () => {
        expect(convertTools(undefined)).toBeUndefined();
        expect(convertTools([])).toBeUndefined();
    });

    it('maps a tool to the function schema', () => {
        const schema = { type: 'object', properties: { path: {} } };
        expect(
            convertTools([
                { name: 'read_file', description: 'Read', inputSchema: schema },
            ])
        ).toEqual([
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read',
                    parameters: schema,
                },
            },
        ]);
    });

    it('supplies an empty object schema when none is given', () => {
        const [tool] =
            convertTools([{ name: 'now', description: 'Current time' }]) ?? [];
        expect(tool?.function.parameters).toEqual({
            type: 'object',
            properties: {},
        });
    });
});

describe('convertToolMode', () => {
    it('maps Required to required and everything else to auto', () => {
        expect(
            convertToolMode(vscode.LanguageModelChatToolMode.Required)
        ).toBe('required');
        expect(convertToolMode(vscode.LanguageModelChatToolMode.Auto)).toBe(
            'auto'
        );
        expect(convertToolMode(undefined)).toBe('auto');
    });
});
