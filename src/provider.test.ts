import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
    FIRST_OUTPUT_TIMEOUT_MS,
    parseArguments,
    STREAM_IDLE_TIMEOUT_MS,
    TetrateChatModelProvider,
    ToolCallAccumulator,
} from './provider';
import type { ActiveRequest } from './usage';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Delta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;
type FinishReason =
    OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'];
type ToolCallDelta =
    OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall;
type ResponseOptions = vscode.ProvideLanguageModelChatResponseOptions;

describe('ToolCallAccumulator', () => {
    it('reassembles a call split across chunks', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            {
                index: 0,
                id: 'call-1',
                function: { name: 'read_file', arguments: '{"pa' },
            },
        ]);
        accumulator.add([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]);

        expect(accumulator.finish()).toEqual([
            { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
        ]);
    });

    it('does not duplicate a name a gateway repeats on every chunk', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            {
                index: 0,
                id: 'call-1',
                function: { name: 'read_file', arguments: '{"pa' },
            },
        ]);
        accumulator.add([
            {
                index: 0,
                function: { name: 'read_file', arguments: 'th":"a.ts"}' },
            },
        ]);

        expect(accumulator.finish()[0]?.name).toBe('read_file');
    });

    it('keeps parallel calls apart and orders them by index', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
            { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
        ]);

        expect(accumulator.finish().map((call) => call.name)).toEqual([
            'first',
            'second',
        ]);
    });

    it('synthesizes an id when the gateway omits one', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 2, function: { name: 'now', arguments: '{}' } },
        ]);

        expect(accumulator.finish()[0]?.id).toBe('call_2');
    });

    it('keeps synthesized ids distinct across turns', () => {
        // Index alone repeats every response, so replaying a history of turns
        // from a gateway that omits ids would reuse one id for two calls.
        const first = new ToolCallAccumulator('call_0');
        const second = new ToolCallAccumulator('call_1');
        const delta = [{ index: 0, function: { name: 'now', arguments: '{}' } }];
        first.add(delta);
        second.add(delta);

        expect(first.finish()[0]?.id).toBe('call_0_0');
        expect(second.finish()[0]?.id).toBe('call_1_0');
    });

    it('reports arguments it could not parse so they can be logged', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 0, id: 'a', function: { name: 'read', arguments: '{"pa' } },
        ]);

        const [call] = accumulator.finish();
        expect(call?.input).toEqual({});
        expect(call?.malformedArguments).toBe('{"pa');
    });

    it('treats array arguments as malformed', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 0, id: 'a', function: { name: 'read', arguments: '[1,2]' } },
        ]);

        const [call] = accumulator.finish();
        expect(call?.input).toEqual({});
        expect(call?.malformedArguments).toBe('[1,2]');
    });

    it('leaves malformedArguments unset for a clean parse', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 0, id: 'a', function: { name: 'read', arguments: '{}' } },
        ]);

        expect(accumulator.finish()[0]?.malformedArguments).toBeUndefined();
    });

    it('ignores a delta that never produced a name', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([{ index: 0, id: 'call-1' }]);
        accumulator.add(undefined);

        expect(accumulator.finish()).toEqual([]);
    });
});

describe('parseArguments', () => {
    it('parses a JSON object', () => {
        expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns an empty object for empty, invalid or non-object input', () => {
        expect(parseArguments('')).toEqual({});
        expect(parseArguments('   ')).toEqual({});
        expect(parseArguments('{"a":')).toEqual({});
        expect(parseArguments('null')).toEqual({});
        expect(parseArguments('42')).toEqual({});
        expect(parseArguments('[1,2]')).toEqual({});
    });
});

describe('provideLanguageModelChatResponse', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('throws NoPermissions without calling the client when no key is stored', async () => {
        const h = harness({ steps: [] }, { storedKey: undefined });

        const error = await rejection(h.run());

        expect(error).toBeInstanceOf(vscode.LanguageModelError);
        expect(error).toMatchObject({ code: 'NoPermissions' });
        expect(h.create).not.toHaveBeenCalled();
    });

    it('returns without calling the client when nothing converts to a message', async () => {
        const h = harness({ steps: [] });

        await h.run({}, [user('')]);

        expect(h.create).not.toHaveBeenCalled();
        expect(h.log.warn).toHaveBeenCalledWith(
            expect.stringContaining('no convertible content')
        );
    });

    it('reports text deltas in order', async () => {
        const h = harness({
            steps: [text('Hel'), text('lo'), finish('stop')],
        });

        await h.run();

        expect(h.parts.every((part) => part instanceof vscode.LanguageModelTextPart)).toBe(true);
        expect(texts(h.parts)).toEqual(['Hel', 'lo']);
    });

    it('reports a tool call once the stream ends', async () => {
        const h = harness({
            steps: [
                toolCall({
                    index: 0,
                    id: 'call_abc',
                    function: { name: 'read_file', arguments: '{"pa' },
                }),
                toolCall({ index: 0, function: { arguments: 'th":"a.ts"}' } }),
                finish('tool_calls'),
            ],
        });

        await h.run();

        expect(h.parts).toHaveLength(1);
        expect(h.parts[0]).toBeInstanceOf(vscode.LanguageModelToolCallPart);
        expect(h.parts[0]).toMatchObject({
            callId: 'call_abc',
            name: 'read_file',
            input: { path: 'a.ts' },
        });
    });

    it('synthesizes a tool call id when the gateway omits one', async () => {
        const h = harness({
            steps: [
                toolCall({
                    index: 0,
                    function: { name: 'now', arguments: '{}' },
                }),
                finish('tool_calls'),
            ],
        });

        await h.run();

        expect(h.parts[0]).toMatchObject({ callId: 'call_0_0', name: 'now' });
    });

    it('appends a truncation note when the output limit was hit', async () => {
        const h = harness({ steps: [text('partial'), finish('length')] });

        await h.run();

        expect(texts(h.parts)).toEqual([
            'partial',
            expect.stringContaining('Truncated'),
        ]);
        expect(h.log.warn).toHaveBeenCalledWith(
            expect.stringContaining('output limit')
        );
    });

    it('throws Blocked when a content filter stopped the response before any output', async () => {
        const h = harness({ steps: [finish('content_filter')] });

        const error = await rejection(h.run());

        expect(error).toBeInstanceOf(vscode.LanguageModelError);
        expect(error).toMatchObject({ code: 'Blocked' });
        expect(h.parts).toEqual([]);
    });

    it('appends a note instead when a content filter interrupted output', async () => {
        const h = harness({
            steps: [text('some'), finish('content_filter')],
        });

        await h.run();

        expect(texts(h.parts)).toEqual([
            'some',
            expect.stringContaining('Stopped early'),
        ]);
    });

    it.each([
        [401, 'NoPermissions'],
        [404, 'NotFound'],
    ])('maps an APIError with status %i to %s', async (status, code) => {
        const h = harness({
            rejectWith: new OpenAI.APIError(
                status,
                { message: 'nope' },
                'nope',
                new Headers()
            ),
        });

        const error = await rejection(h.run());

        expect(error).toBeInstanceOf(vscode.LanguageModelError);
        expect(error).toMatchObject({ code });
    });

    it('surfaces other HTTP failures as a plain Error naming the status', async () => {
        const h = harness({
            rejectWith: new OpenAI.APIError(
                500,
                { message: 'upstream exploded' },
                'upstream exploded',
                new Headers()
            ),
        });

        const error = await rejection(h.run());

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(vscode.LanguageModelError);
        expect((error as Error).message).toContain('HTTP 500');
        expect(h.log.error).toHaveBeenCalledWith(
            expect.stringContaining('HTTP 500')
        );
    });

    it('surfaces a chunk-level error the SDK raised mid-stream', async () => {
        // The SDK turns a chunk carrying `error` into an APIError with no
        // status; the provider relies on that rather than checking chunks.
        const h = harness({
            steps: [
                text('partial'),
                {
                    fail: new OpenAI.APIError(
                        undefined,
                        { message: 'quota exceeded' },
                        undefined,
                        new Headers()
                    ),
                },
            ],
        });

        const error = await rejection(h.run());

        expect(texts(h.parts)).toEqual(['partial']);
        expect((error as Error).message).toContain(
            'request failed: quota exceeded'
        );
    });

    it('resolves quietly when the token cancels mid-stream and aborts the request', async () => {
        const h = harness({ steps: [text('hel'), { hang: true }] });

        const pending = h.run();
        await vi.waitFor(() => expect(h.parts).toHaveLength(1));
        h.token.cancel();

        await expect(pending).resolves.toBeUndefined();
        expect(h.requests[0]?.signal.aborted).toBe(true);
        expect(h.log.error).not.toHaveBeenCalled();
    });

    it('does not report an empty response when the stream ends quietly on cancellation', async () => {
        // The installed SDK swallows the abort its iterator sees, so the loop
        // ends as if the answer were complete.
        const h = harness({
            steps: [roleOnly(), { hang: true }],
            onAbort: 'end',
        });

        const pending = h.run();
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        await flush();
        h.token.cancel();

        await expect(pending).resolves.toBeUndefined();
        expect(h.log.warn).not.toHaveBeenCalled();
    });

    it('allows a reasoning model the first-output allowance before calling a stall', async () => {
        vi.useFakeTimers();
        const h = harness({ steps: [roleOnly(), { hang: true }] });

        const pending = h.run();
        const state = settlement(pending);

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);
        expect(state()).toBe('pending');

        await vi.advanceTimersByTimeAsync(FIRST_OUTPUT_TIMEOUT_MS);
        await expect(pending).rejects.toThrow(/no output/);
        expect(h.requests[0]?.signal.aborted).toBe(true);
        expect(h.log.error).toHaveBeenCalledWith(
            expect.stringContaining('no output')
        );
    });

    it('reports a stall once output has started and the stream goes silent', async () => {
        vi.useFakeTimers();
        const h = harness({ steps: [text('hi'), { hang: true }] });

        const pending = h.run();
        const state = settlement(pending);

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);

        expect(state()).toBe('rejected');
        await expect(pending).rejects.toThrow(/stalled/);
        expect(h.requests[0]?.signal.aborted).toBe(true);
    });

    it('reports a stall even when the SDK ends the stream quietly on abort', async () => {
        vi.useFakeTimers();
        const h = harness({
            steps: [text('hi'), { hang: true }],
            onAbort: 'end',
        });

        const pending = h.run();
        settlement(pending);

        await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);

        await expect(pending).rejects.toThrow(/stalled/);
        expect(h.log.error).toHaveBeenCalledWith(
            expect.stringContaining('stalled')
        );
    });

    it('reports the answering backend when it differs from the requested id', async () => {
        const fallback = (delta: Delta, finishReason: FinishReason = null) => ({
            ...chunk(delta, finishReason),
            model: 'vertexanthropic/claude-test',
        });
        const h = harness(
            {
                steps: [
                    fallback({ content: 'hi' }),
                    fallback({}, 'stop'),
                    {
                        ...usageChunk({
                            prompt_tokens: 1_000_000,
                            completion_tokens: 0,
                            total_tokens: 1_000_000,
                        }),
                        model: 'vertexanthropic/claude-test',
                    },
                ],
            },
            {
                // Only the answering backend has a price, so the booked cost
                // proves the fallback's rate was used.
                storedCatalog: {
                    fetchedAt: Date.now(),
                    models: [
                        {
                            model: 'vertexanthropic/claude-test',
                            inputTokensPricePer1M: 4,
                            outputTokensPricePer1M: 20,
                        },
                    ],
                },
            }
        );
        const listener = vi.fn();
        h.provider.usage.subscribe(listener);

        await h.run();

        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({
                modelId: MODEL.id,
                meta: expect.objectContaining({
                    servedBy: 'vertexanthropic/claude-test',
                }) as unknown,
            })
        );
        expect(h.provider.usage.totalCost).toBeCloseTo(4);
        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringContaining('served by vertexanthropic/claude-test')
        );
    });

    it('reports no servedBy when the response echoes the requested id', async () => {
        const h = harness({
            steps: [
                text('hi'),
                finish('stop'),
                usageChunk({
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                }),
            ],
        });
        const listener = vi.fn();
        h.provider.usage.subscribe(listener);

        await h.run();

        const event = listener.mock.calls[0]?.[0] as {
            meta?: { servedBy?: string };
        };
        expect(event.meta?.servedBy).toBeUndefined();
    });

    it('runs the outage triage when a request fails', async () => {
        const h = harness(
            {
                rejectWith: new OpenAI.APIError(
                    503,
                    { message: 'upstream exploded' },
                    'upstream exploded',
                    new Headers()
                ),
            },
            {
                gatewayStatus: { reachable: true, status: 'serving' },
                providerReport: {
                    providers: [
                        {
                            name: 'anthropic',
                            reachable: false,
                            observedRequests: 3,
                            failures: 3,
                            lastFailureCode: '529',
                        },
                    ],
                },
            }
        );

        await rejection(h.run());
        await flush();

        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringContaining('Triage: gateway serving')
        );
        expect(h.log.warn).toHaveBeenCalledWith(
            expect.stringContaining('Triage: provider anthropic failing (529)')
        );
    });

    it('names the gateway as the problem when it reports not serving', async () => {
        const h = harness(
            {
                rejectWith: new OpenAI.APIError(
                    503,
                    { message: 'boom' },
                    'boom',
                    new Headers()
                ),
            },
            {
                gatewayStatus: {
                    reachable: true,
                    status: 'not_serving',
                    message: 'upgrade',
                },
            }
        );

        await rejection(h.run());
        await flush();

        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'the gateway itself is the problem'
            )
        );
    });

    it('sends the attribution header only when opted in', async () => {
        const { configValues } = vscode as unknown as {
            configValues: Record<string, unknown>;
        };
        try {
            configValues.sessionAttribution = true;
            const h = harness({ steps: [finish('stop')] });
            await h.run();
            const opted = h.clientOptions[0] as {
                defaultHeaders: Record<string, string>;
            };
            expect(opted.defaultHeaders['agent-session-id']).toMatch(/^[0-9a-f-]{36}$/);

            delete configValues.sessionAttribution;
            const plain = harness({ steps: [finish('stop')] });
            await plain.run();
            const defaults = plain.clientOptions[0] as {
                defaultHeaders: Record<string, string>;
            };
            expect(defaults.defaultHeaders['agent-session-id']).toBeUndefined();
        } finally {
            delete configValues.sessionAttribution;
        }
    });

    it('marks the model reasoning-capable when a reasoning override is set', async () => {
        const { configValues } = vscode as unknown as {
            configValues: Record<string, unknown>;
        };
        configValues.modelOverrides = {
            'claude-*': { reasoningEffort: 'high' },
        };
        try {
            const h = harness({ steps: [finish('stop')] });
            await h.run();
            expect(
                h.requests[0]?.headers?.['x-tars-supports-reasoning']
            ).toBe('true');
        } finally {
            delete configValues.modelOverrides;
        }

        const plain = harness({ steps: [finish('stop')] });
        await plain.run();
        expect(
            plain.requests[0]?.headers?.['x-tars-supports-reasoning']
        ).toBeUndefined();
    });

    it('logs the fields the gateway dropped crossing providers', async () => {
        const h = harness({
            steps: [text('hi'), finish('stop')],
            responseHeaders: {
                'x-tars-dropped-fields': 'web_search_20250305',
            },
        });

        await h.run();

        expect(h.log.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'dropped request fields crossing providers: web_search_20250305'
            )
        );
    });

    it('sends a unique X-Request-ID for Request Logs correlation', async () => {
        const h = harness({ steps: [finish('stop')] });

        await h.run();
        await h.run();

        const ids = h.requests.map(
            (request) => request.headers?.['X-Request-ID']
        );
        expect(ids[0]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('tells a budget-blocked 429 apart from a rate limit', async () => {
        const blocked = harness({
            rejectWith: new OpenAI.APIError(
                429,
                { message: 'budget exhausted' },
                'budget exhausted',
                new Headers({ 'x-tars-budget-action': 'block' })
            ),
        });
        const budgetError = await rejection(blocked.run());
        expect((budgetError as Error).message).toContain('spend budget');
        expect((budgetError as Error).message).toContain(
            'retrying will not help'
        );

        const limited = harness({
            rejectWith: new OpenAI.APIError(
                429,
                { message: 'slow down' },
                'slow down',
                new Headers()
            ),
        });
        const rateError = await rejection(limited.run());
        expect((rateError as Error).message).toContain('Rate limited');
    });

    it('explains each model lifecycle code', async () => {
        const h = harness({
            rejectWith: new OpenAI.APIError(
                503,
                { message: 'not ready', code: 'model_not_ready' },
                'not ready',
                new Headers({ 'retry-after': '30' })
            ),
        });
        const error = await rejection(h.run());
        expect((error as Error).message).toContain('not active yet');
        expect((error as Error).message).toContain('retry in 30s');

        const notRouted = harness({
            rejectWith: new OpenAI.APIError(
                404,
                { message: 'no route', code: 'model_not_routed' },
                'no route',
                new Headers()
            ),
        });
        const routeError = await rejection(notRouted.run());
        expect((routeError as Error).message).toContain('model grants');
    });

    it('offers the right hostnames on a project mismatch 403', async () => {
        const h = harness({
            rejectWith: new OpenAI.APIError(
                403,
                {
                    message: 'wrong host',
                    category: 'hostname_not_selected',
                    your_hostnames: ['proxy.acme.tetrate.ai'],
                },
                'wrong host',
                new Headers()
            ),
        });

        const error = await rejection(h.run());
        expect(error).toBeInstanceOf(vscode.LanguageModelError);
        expect(error).toMatchObject({ code: 'NoPermissions' });
        expect((error as Error).message).toContain('proxy.acme.tetrate.ai');
        expect((error as Error).message).toContain('Switch Endpoint');
    });

    it('forwards modelOptions without letting them override the request shape', async () => {
        const h = harness({ steps: [finish('stop')] });

        await h.run({
            modelOptions: { temperature: 0.2, model: 'evil', stream: false },
        });

        expect(h.requests[0]?.body).toMatchObject({
            temperature: 0.2,
            model: MODEL.id,
            stream: true,
        });
    });

    it.each([
        [vscode.LanguageModelChatToolMode.Auto, 'auto'],
        [vscode.LanguageModelChatToolMode.Required, 'required'],
    ])('sends tools with tool_choice for mode %i', async (toolMode, choice) => {
        const h = harness({ steps: [finish('stop')] });

        await h.run({
            toolMode,
            tools: [
                {
                    name: 'read_file',
                    description: 'Reads a file',
                    inputSchema: { type: 'object', properties: {} },
                },
            ],
        });

        const body = h.requests[0]?.body;
        expect(body?.tool_choice).toBe(choice);
        expect(body?.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Reads a file',
                    parameters: { type: 'object', properties: {} },
                },
            },
        ]);
    });

    it('omits tools and tool_choice when no tools are offered', async () => {
        const h = harness({ steps: [finish('stop')] });

        await h.run({ tools: [] });

        expect(h.requests[0]?.body).not.toHaveProperty('tools');
        expect(h.requests[0]?.body).not.toHaveProperty('tool_choice');
    });

    it('asks for billed usage, and callers cannot switch it off', async () => {
        const h = harness({ steps: [finish('stop')] });

        await h.run({ modelOptions: { stream_options: { include_usage: false } } });

        expect(h.requests[0]?.body).toMatchObject({
            stream_options: { include_usage: true },
        });
    });

    it('records billed usage from the final chunk', async () => {
        const h = harness({
            steps: [
                text('hi'),
                finish('stop'),
                usageChunk({
                    prompt_tokens: 1200,
                    completion_tokens: 34,
                    total_tokens: 1234,
                    prompt_tokens_details: { cached_tokens: 200 },
                    completion_tokens_details: { reasoning_tokens: 10 },
                }),
            ],
        });

        await h.run();

        expect(h.provider.usage.requestCount).toBe(1);
        expect(h.provider.usage.totalTokens).toBe(1234);
        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringContaining('1,200 in (200 cached) + 34 out')
        );
    });

    it('shows the request in activity while streaming and clears it after', async () => {
        const h = harness({ steps: [text('hi'), finish('stop')] });
        const snapshots: ActiveRequest[][] = [];
        h.provider.activity.subscribe(() => {
            snapshots.push([...h.provider.activity.active]);
        });

        await h.run();

        // One snapshot per change: begin, first output, end.
        expect(snapshots).toHaveLength(3);
        expect(snapshots[0]).toEqual([
            expect.objectContaining({
                modelId: MODEL.id,
                outputStarted: false,
            }),
        ]);
        expect(snapshots[1]).toEqual([
            expect.objectContaining({ modelId: MODEL.id, outputStarted: true }),
        ]);
        expect(snapshots[2]).toEqual([]);
        expect(h.provider.activity.active).toEqual([]);
    });

    it('emits a usage event carrying the finish reason and duration', async () => {
        const h = harness({
            steps: [
                text('hi'),
                finish('stop'),
                usageChunk({
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                }),
            ],
        });
        const listener = vi.fn();
        h.provider.usage.subscribe(listener);

        await h.run();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({
                modelId: MODEL.id,
                meta: expect.objectContaining({
                    finishReason: 'stop',
                    durationMs: expect.any(Number),
                }),
            })
        );
    });

    it('books a first-output sample for a request that produced output', async () => {
        const h = harness({
            steps: [
                text('hi'),
                finish('stop'),
                usageChunk({
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                }),
            ],
        });

        await h.run();

        expect(h.provider.usage.firstOutputStats('claude-test')).toMatchObject({
            samples: 1,
        });
    });

    it('logs timing but records nothing when the gateway sends no usage block', async () => {
        const h = harness({ steps: [text('hi'), finish('stop')] });

        await h.run();

        expect(h.provider.usage.requestCount).toBe(0);
        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringMatching(
                /completed \(first output \d+\.\ds, total \d+\.\ds\); no usage block received/
            )
        );
    });

    it('appends the request timing to the usage log line', async () => {
        const h = harness({
            steps: [
                text('hi'),
                finish('stop'),
                usageChunk({
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                }),
            ],
        });

        await h.run();

        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringMatching(
                /10 in \+ 5 out \(first output \d+\.\ds, total \d+\.\ds\)/
            )
        );
    });

    it('prices a request from the cached public catalog', async () => {
        const h = harness(
            {
                steps: [
                    text('hi'),
                    finish('stop'),
                    usageChunk({
                        prompt_tokens: 1_000_000,
                        completion_tokens: 0,
                        total_tokens: 1_000_000,
                    }),
                ],
            },
            {
                storedCatalog: {
                    fetchedAt: Date.now(),
                    models: [
                        {
                            model: 'claude-test',
                            inputTokensPricePer1M: 2,
                            outputTokensPricePer1M: 10,
                        },
                    ],
                },
            }
        );

        await h.run();

        expect(h.provider.usage.totalCost).toBeCloseTo(2);
        expect(h.log.info).toHaveBeenCalledWith(
            expect.stringContaining('$2.00')
        );
    });

    it('applies per-model overrides, outranking caller modelOptions', async () => {
        const { configValues } = vscode as unknown as {
            configValues: Record<string, unknown>;
        };
        configValues.modelOverrides = {
            'claude-*': {
                temperature: 0.1,
                reasoningEffort: 'high',
                maxTokens: 2048,
            },
        };
        try {
            const h = harness({ steps: [finish('stop')] });

            await h.run({ modelOptions: { temperature: 0.9 } });

            expect(h.requests[0]?.body).toMatchObject({
                temperature: 0.1,
                reasoning_effort: 'high',
                max_tokens: 2048,
            });
        } finally {
            delete configValues.modelOverrides;
        }
    });
});

const MODEL: vscode.LanguageModelChatInformation = {
    id: 'claude-test',
    name: 'Claude Test',
    family: 'claude',
    version: '1',
    maxInputTokens: 100_000,
    maxOutputTokens: 4_096,
    capabilities: { toolCalling: true },
};

function user(content: string): vscode.LanguageModelChatRequestMessage {
    return {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart(content)],
        name: undefined,
    };
}

function chunk(delta: Delta, finishReason: FinishReason = null): Chunk {
    return {
        id: 'chunk',
        object: 'chat.completion.chunk',
        created: 0,
        model: MODEL.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

const roleOnly = () => chunk({ role: 'assistant' });
const text = (content: string) => chunk({ content });
const finish = (reason: FinishReason) => chunk({}, reason);
const toolCall = (call: ToolCallDelta) => chunk({ tool_calls: [call] });

/** The extra final chunk `stream_options.include_usage` produces. */
const usageChunk = (usage: OpenAI.Completions.CompletionUsage): Chunk => ({
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL.id,
    choices: [],
    usage,
});

function texts(parts: readonly vscode.LanguageModelResponsePart[]): string[] {
    return parts
        .filter(
            (part): part is vscode.LanguageModelTextPart =>
                part instanceof vscode.LanguageModelTextPart
        )
        .map((part) => part.value);
}

/** A chunk to yield, a timed pause, a failure to raise, or a hang until abort. */
type Step = Chunk | { wait: number } | { fail: unknown } | { hang: true };

type Behaviour =
    | {
          steps: Step[];
          onAbort?: 'throw' | 'end';
          responseHeaders?: Record<string, string>;
      }
    | { rejectWith: unknown };

type Request = {
    body: Record<string, unknown>;
    signal: AbortSignal;
    headers?: Record<string, string>;
};

function abortError(): Error {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

/** Resolves with `work`, or rejects with an AbortError as soon as the signal fires. */
function untilAborted(signal: AbortSignal, work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        void work.then(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        });
    });
}

/**
 * Plays a script as the async iterable the SDK hands back. Pauses run on
 * timers so fake timers can drive them; `hang` blocks until the request is
 * aborted. On abort a pending step rejects with an AbortError, or with
 * `onAbort: 'end'` finishes the stream quietly, which is what the installed
 * SDK does with the abort its own iterator sees.
 */
async function* scriptedStream(
    steps: Step[],
    signal: AbortSignal,
    onAbort: 'throw' | 'end'
): AsyncGenerator<Chunk> {
    try {
        for (const step of steps) {
            if ('hang' in step) {
                await untilAborted(signal, new Promise<void>(() => {}));
            } else if ('wait' in step) {
                await untilAborted(
                    signal,
                    new Promise<void>((resolve) => setTimeout(resolve, step.wait))
                );
            } else if ('fail' in step) {
                throw step.fail;
            } else {
                yield step;
            }
        }
    } catch (error) {
        if (
            onAbort === 'end' &&
            error instanceof Error &&
            error.name === 'AbortError'
        ) {
            return;
        }
        throw error;
    }
}

function fakeClient(behaviour: Behaviour) {
    const requests: Request[] = [];
    const create = vi.fn(
        (
            body: Record<string, unknown>,
            options: { signal: AbortSignal; headers?: Record<string, string> }
        ) => {
            requests.push({
                body,
                signal: options.signal,
                headers: options.headers,
            });
            // Mirrors the SDK's APIPromise: awaitable directly, and also
            // carrying withResponse() for callers that need the headers.
            const outcome: Promise<unknown> =
                'rejectWith' in behaviour
                    ? Promise.reject(behaviour.rejectWith)
                    : Promise.resolve(
                          scriptedStream(
                              behaviour.steps,
                              options.signal,
                              behaviour.onAbort ?? 'throw'
                          )
                      );
            // The provider only awaits withResponse when present, so the
            // bare rejection would otherwise count as unhandled.
            outcome.catch(() => undefined);
            const pending = outcome as Promise<unknown> & {
                withResponse(): Promise<{
                    data: unknown;
                    response: { headers: Headers };
                }>;
            };
            pending.withResponse = () =>
                outcome.then((data) => ({
                    data,
                    response: {
                        headers: new Headers(
                            'responseHeaders' in behaviour
                                ? behaviour.responseHeaders
                                : {}
                        ),
                    },
                }));
            return pending;
        }
    );
    return {
        client: { chat: { completions: { create } } } as unknown as OpenAI,
        create,
        requests,
    };
}

function cancellationToken() {
    const listeners = new Set<(e: unknown) => unknown>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(listener: (e: unknown) => unknown) {
            listeners.add(listener);
            return {
                dispose: () => {
                    listeners.delete(listener);
                },
            };
        },
        cancel() {
            token.isCancellationRequested = true;
            for (const listener of [...listeners]) {
                listener(undefined);
            }
        },
    };
    return token;
}

type HarnessOptions = {
    storedKey?: string | undefined;
    /** Served as the persisted public-catalog cache, for pricing lookups. */
    storedCatalog?: unknown;
    /** What the stubbed health triage reports. */
    gatewayStatus?: import('./health').GatewayStatus;
    providerReport?: import('./health').ProviderReport;
};

function harness(behaviour: Behaviour, options: HarnessOptions = {}) {
    const storedKey = 'storedKey' in options ? options.storedKey : 'sk-test';
    const fake = fakeClient(behaviour);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const context = {
        secrets: { get: vi.fn(() => Promise.resolve(storedKey)) },
        globalState: {
            get: () => options.storedCatalog,
            update: () => Promise.resolve(),
        },
    };
    const clientOptions: unknown[] = [];
    const provider = new TetrateChatModelProvider(
        context as unknown as vscode.ExtensionContext,
        log as unknown as vscode.LogOutputChannel,
        (createOptions) => {
            clientOptions.push(createOptions);
            return fake.client;
        },
        // Stubbed so a failing test request never triages over the network.
        {
            gateway: () =>
                Promise.resolve(
                    options.gatewayStatus ?? { reachable: true as const }
                ),
            providers: () => Promise.resolve(options.providerReport),
        }
    );
    const parts: vscode.LanguageModelResponsePart[] = [];
    const token = cancellationToken();

    const run = (
        overrides: Partial<ResponseOptions> = {},
        messages: vscode.LanguageModelChatRequestMessage[] = [user('hello')]
    ) =>
        provider.provideLanguageModelChatResponse(
            MODEL,
            messages,
            { toolMode: vscode.LanguageModelChatToolMode.Auto, ...overrides },
            {
                report: (part) => {
                    parts.push(part);
                },
            },
            token
        );

    return {
        run,
        parts,
        log,
        token,
        provider,
        create: fake.create,
        clientOptions,
        requests: fake.requests,
    };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected the promise to reject');
}

/** Tracks how a promise settled without awaiting it, for fake-timer tests. */
function settlement(
    promise: Promise<unknown>
): () => 'pending' | 'resolved' | 'rejected' {
    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    promise.then(
        () => {
            state = 'resolved';
        },
        () => {
            state = 'rejected';
        }
    );
    return () => state;
}

/** Lets queued microtasks and one macrotask run; real timers only. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
