import OpenAI from 'openai';
import * as vscode from 'vscode';

import {
    fetchApiModels,
    fetchPublicCatalog,
    selectChatModels,
} from './catalog';
import { getConfig, type ProviderConfig } from './config';
import { convertMessages, convertToolMode, convertTools } from './messages';
import { getApiKey, resolveApiKey } from './secrets';
import { countTokens } from './tokenCount';

const USER_AGENT = 'vscode-tetrate-model-provider';

export class TetrateChatModelProvider
    implements vscode.LanguageModelChatProvider, vscode.Disposable
{
    private readonly onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this.onDidChange.event;

    /** Keyed by base URL and filter so a settings change cannot serve stale models. */
    private cache?: { key: string; models: vscode.LanguageModelChatInformation[] };

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: vscode.LogOutputChannel
    ) {}

    dispose(): void {
        this.onDidChange.dispose();
    }

    /**
     * Discards the cached model list and asks VS Code to re-query. Called after
     * the key or base URL changes, and by the refresh command.
     */
    invalidate(): void {
        this.cache = undefined;
        this.onDidChange.fire();
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = getConfig();
        const apiKey = await resolveApiKey(this.context, options.silent);
        if (!apiKey) {
            // With no key there is nothing to offer. Staying quiet here is
            // required in silent mode and reasonable otherwise, since the user
            // just dismissed the prompt.
            return [];
        }

        // The API key is deliberately not part of this key: every path that
        // changes it calls invalidate(), and keeping the secret out of a
        // long-lived string avoids it surfacing anywhere unintended.
        const cacheKey = `${config.baseUrl}|${config.modelFilter.join(',')}`;
        if (this.cache?.key === cacheKey) {
            return this.cache.models;
        }

        try {
            const [apiModels, catalog] = await Promise.all([
                fetchApiModels(
                    config.baseUrl,
                    apiKey,
                    config.requestHeaders,
                    token
                ),
                fetchPublicCatalog(token),
            ]);

            const models = selectChatModels(apiModels, catalog, config);
            this.log.info(
                `Discovered ${models.length} chat model(s) at ${config.baseUrl}`
            );
            if (models.length === 0 && apiModels.length > 0) {
                this.log.warn(
                    `${apiModels.length} model(s) returned but none matched the chat filter`
                );
            }

            this.cache = { key: cacheKey, models };
            return models;
        } catch (error) {
            if (token.isCancellationRequested) {
                return [];
            }
            this.log.error(`Failed to list models: ${describe(error)}`);
            if (!options.silent) {
                await this.reportListFailure(error);
            }
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = getConfig();
        const apiKey = await getApiKey(this.context);
        if (!apiKey) {
            throw vscode.LanguageModelError.NoPermissions(
                'No Agent Router API key is configured. Run "Tetrate Agent Router: Set Agent Router API Key".'
            );
        }

        const chatMessages = convertMessages(messages);
        if (chatMessages.length === 0) {
            return;
        }

        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() =>
            controller.abort()
        );

        try {
            const tools = convertTools(options.tools);
            const stream = await this.client(config, apiKey).chat.completions.create(
                {
                    // Callers may pass provider-specific knobs such as
                    // temperature, max_tokens or reasoning_effort straight
                    // through. Spread first so the fields below cannot be
                    // overridden — clobbering `stream` or `messages` would
                    // break the response handling outright.
                    ...(options.modelOptions ?? {}),
                    model: model.id,
                    messages: chatMessages,
                    stream: true,
                    ...(tools
                        ? {
                              tools,
                              tool_choice: convertToolMode(options.toolMode),
                          }
                        : {}),
                },
                { signal: controller.signal }
            );

            const toolCalls = new ToolCallAccumulator();
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (!delta) {
                    continue;
                }
                if (delta.content) {
                    progress.report(
                        new vscode.LanguageModelTextPart(delta.content)
                    );
                }
                toolCalls.add(delta.tool_calls);
            }

            // Arguments arrive as string fragments, so a call is only reportable
            // once the stream has finished delivering it.
            for (const call of toolCalls.finish()) {
                progress.report(
                    new vscode.LanguageModelToolCallPart(
                        call.id,
                        call.name,
                        call.input
                    )
                );
            }
        } catch (error) {
            if (isAbort(error) || token.isCancellationRequested) {
                return;
            }
            this.log.error(
                `Request to ${model.id} failed: ${describe(error)}`
            );
            throw toLanguageModelError(error);
        } finally {
            cancellation.dispose();
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        return countTokens(text);
    }

    private client(config: ProviderConfig, apiKey: string): OpenAI {
        // Cheap to construct, and the base URL or key may have changed since the
        // last request, so this is not cached.
        return new OpenAI({
            apiKey,
            baseURL: config.baseUrl,
            defaultHeaders: {
                'User-Agent': USER_AGENT,
                ...config.requestHeaders,
            },
        });
    }

    private async reportListFailure(error: unknown): Promise<void> {
        const setKey = 'Set API Key';
        const setUrl = 'Set Base URL';
        const action = await vscode.window.showErrorMessage(
            `Tetrate Agent Router: could not list models. ${describe(error)}`,
            setKey,
            setUrl
        );
        if (action === setKey) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setApiKey'
            );
        } else if (action === setUrl) {
            await vscode.commands.executeCommand(
                'tetrate-model-provider.setBaseUrl'
            );
        }
    }
}

type StreamedToolCall = { id: string; name: string; input: object };

/**
 * Reassembles tool calls from streaming deltas. The protocol identifies a call
 * by its position in the array, and `id`, `name` and `arguments` may each be
 * split across chunks.
 */
export class ToolCallAccumulator {
    private readonly byIndex = new Map<
        number,
        { id: string; name: string; args: string }
    >();

    add(
        deltas:
            | readonly OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
            | undefined
    ): void {
        for (const delta of deltas ?? []) {
            const entry = this.byIndex.get(delta.index) ?? {
                id: '',
                name: '',
                args: '',
            };
            if (delta.id) {
                entry.id = delta.id;
            }
            if (delta.function?.name) {
                entry.name += delta.function.name;
            }
            if (delta.function?.arguments) {
                entry.args += delta.function.arguments;
            }
            this.byIndex.set(delta.index, entry);
        }
    }

    finish(): StreamedToolCall[] {
        const calls: StreamedToolCall[] = [];
        for (const [index, entry] of [...this.byIndex.entries()].sort(
            (a, b) => a[0] - b[0]
        )) {
            if (!entry.name) {
                continue;
            }
            calls.push({
                // A gateway that omits the id still leaves the call usable, and
                // the index is unique within the response.
                id: entry.id || `call_${index}`,
                name: entry.name,
                input: parseArguments(entry.args),
            });
        }
        return calls;
    }
}

/**
 * Tool arguments are a JSON string. A model can emit an unparseable fragment, in
 * which case an empty object lets the tool report a normal validation failure
 * instead of breaking the whole turn.
 */
export function parseArguments(args: string): object {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function isAbort(error: unknown): boolean {
    return (
        error instanceof OpenAI.APIUserAbortError ||
        (error instanceof Error && error.name === 'AbortError')
    );
}

function toLanguageModelError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
        const message = `Agent Router: ${describe(error)}`;
        if (error.status === 401 || error.status === 403) {
            return vscode.LanguageModelError.NoPermissions(message);
        }
        if (error.status === 404) {
            return vscode.LanguageModelError.NotFound(message);
        }
        return new Error(message);
    }
    return error instanceof Error ? error : new Error(String(error));
}

function describe(error: unknown): string {
    if (error instanceof OpenAI.APIError) {
        const status = error.status ? `HTTP ${error.status}` : 'request failed';
        return `${status}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}
