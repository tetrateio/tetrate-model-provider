# Tetrate Agent Router Model Provider

A VS Code [language model provider](https://code.visualstudio.com/docs/agent-customization/language-models) for [Tetrate Agent Router Service](https://tetrate.ai/). It contributes every chat model an Agent Router API key can reach to the VS Code chat view, and to any extension that selects models through the `vscode.lm` API.

Models are discovered from the endpoint at runtime, so newly released models appear without an extension update.

![The VS Code chat model picker listing Claude Opus 5 and GPT-5.6 Terra under Tetrate Agent Router](https://raw.githubusercontent.com/tetrateio/tetrate-model-provider/master/images/model-picker.png)

## Why use this

VS Code can already talk to an OpenAI-compatible endpoint through its built-in Custom Endpoint support. That path is limited to the chat view: other extensions calling `vscode.lm.selectChatModels()` cannot see those models.

Registering as a provider extension removes that limitation. One Agent Router key then serves:

- The chat view and agent mode
- Any third-party extension that selects models through `vscode.lm`
- Anthropic, OpenAI, Google, xAI, Groq, and DeepInfra models behind a single endpoint and a single bill

![The Language Models view with the Tetrate Agent Router group expanded, showing each model's context size and tool and vision support](https://raw.githubusercontent.com/tetrateio/tetrate-model-provider/master/images/manage-language-models.png)

## Requirements

| Requirement | Detail |
| --- | --- |
| VS Code | 1.106 or newer |
| API key | An Agent Router API key from the [Agent Router dashboard](https://router.tetrate.ai/) |
| Network | Outbound HTTPS to the configured base URL, and to `router.tetrate.ai` for model metadata |

VS Code 1.106 is the floor because `LanguageModelDataPart`, which carries image input, first appears in that version. The provider registration API itself is stable from 1.104.

## Installation

### Option 1: Install from the Visual Studio Code Marketplace (recommended)

1. Open Visual Studio Code.  
1. Open the Extensions view.  
1. Search for **Tetrate Agent Router Model Provider**, and install it.  

Or from a terminal:

```bash
code --install-extension tetrate.tetrate-model-provider
```

### Option 2: Install from a local VSIX

1. Download [tetrate-model-provider-0.2.0.vsix](https://github.com/tetrateio/tetrate-model-provider/releases/download/v0.2.0/tetrate-model-provider-0.2.0.vsix) from the [Github repo](https://github.com/tetrateio/tetrate-model-provider).
1. Install from command line using `code`:

```bash
code --install-extension tetrate-model-provider-0.2.0.vsix
```

Alternatively, open the Extensions view, choose **Install from VSIX…** from the `⋯` menu, and select the file.

Reload afterwards with **Developer: Reload Window**.

### Option 3: Build from source, for development

1. Check out the project's sources from GitHub: `git clone https://github.com/tetrateio/tetrate-model-provider.git`.
1. Open the project in VS Code
1. Press <kbd>F5</kbd>. This builds the bundle and launches a second window with the extension loaded, which avoids reinstalling on every change.

## Quick start

1. Install the extension and reload VS Code.
2. Run **Tetrate Agent Router: Set Agent Router API Key** from the Command Palette and paste the key.
3. Run **Chat: Manage Language Models**, select **Tetrate Agent Router**, and enable the required models.

Step 2 is optional. The first time VS Code resolves models interactively, for example when opening **Chat: Manage Language Models**, the extension prompts for the key.

Step 3 is not optional. Models contributed by an extension start out hidden in the chat model picker and do not appear until enabled there.

### Where the key is stored

The key is held in VS Code [secret storage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) under `tetrate-model-provider.agentRouterApiKey`. It is never written to a settings file, a log, or the output channel. On macOS that means the system Keychain.

Secret storage is per-machine and does not sync across Settings Sync.

## Configuration

| Setting | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `tetrate-model-provider.baseUrl` | string | `https://api.router.tetrate.ai/v1` | machine | The OpenAI-compatible endpoint to call. |
| `tetrate-model-provider.modelFilter` | string[] | `[]` | window | Glob patterns limiting which models are offered. Empty offers every chat model. |
| `tetrate-model-provider.requestHeaders` | object | `{}` | machine | Extra HTTP headers sent with every request. |

`baseUrl` and `requestHeaders` are machine-scoped, so they can be set in User settings but not in a workspace or folder `settings.json`. Both decide where the API key is sent, and a cloned repository must not be able to point it somewhere else. `modelFilter` only narrows the picker, so it stays settable per workspace.

Changing any of these reloads the model list. **Tetrate Agent Router: Refresh Model List** does the same on demand.

### Pointing at another endpoint

The base URL is pre-configured for the hosted service and can be changed, either in Settings or with **Tetrate Agent Router: Set Base URL**. Use this for an Enterprise or self-hosted Agent Router deployment:

```jsonc
{
    "tetrate-model-provider.baseUrl": "https://router.tare-<tenantID>.tetrate.ai/v1"
}
```

Input is normalized before use. Surrounding whitespace and trailing slashes are stripped, and `/v1` is appended when no version segment is present, so all three of these resolve to the same endpoint:

```text
https://router.tare-<tenantID>.tetrate.ai
https://router.tare-<tenantID>.tetrate.ai/v1
https://router.tare-<tenantID>.tetrate.ai/v1/
```

A URL that already carries an explicit version segment, such as `/v2`, is left alone. Both `http` and `https` are accepted, which allows a local proxy on `http://localhost:8080`.

### Filtering the model list

The hosted catalog currently exposes more than 160 conversational models. To keep the picker manageable, restrict it by glob pattern:

```jsonc
{
    "tetrate-model-provider.modelFilter": ["claude-*", "gpt-5.6-*", "gemini-3.1-pro-preview"]
}
```

Only `*` is special and it matches within and across segments. Everything else, including `.` and `-`, compares literally, and matching is case-insensitive. A model is offered when it matches at least one pattern.

### Adding request headers

Use `requestHeaders` for a routing hint or a tenant identifier required by a self-hosted deployment:

```jsonc
{
    "tetrate-model-provider.requestHeaders": {
        "X-Tenant-Id": "team-platform"
    }
}
```

Do not put the API key here. It belongs in secret storage, and settings files are frequently committed to source control. An `Authorization` entry is discarded: that header is always derived from the stored key.

## Commands

| Command | Description |
| --- | --- |
| Tetrate Agent Router: Set Agent Router API Key | Store or replace the API key. |
| Tetrate Agent Router: Clear Agent Router API Key | Remove the stored key. |
| Tetrate Agent Router: Set Base URL | Change the endpoint, with validation. |
| Tetrate Agent Router: Refresh Model List | Discard the cached model list and re-query the endpoint. |

## Using the models from another extension

Consumers go through the VS Code API and need no dependency on this extension. Select by vendor:

```ts
const [model] = await vscode.lm.selectChatModels({
    vendor: 'tetrate-agent-router',
    // family: 'anthropic',
    // id: 'claude-sonnet-5',
});
if (!model) {
    return;
}

const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User('Summarize this file.')],
    {},
    cancellationToken
);

for await (const chunk of response.text) {
    process.stdout.write(chunk);
}
```

The selector fields map onto the model list as follows:

| Selector | Value | Example |
| --- | --- | --- |
| `vendor` | Always `tetrate-agent-router` | `tetrate-agent-router` |
| `family` | The upstream provider name | `anthropic`, `openai`, `gemini`, `xai`, `groq` |
| `id` | The model id as the endpoint reports it | `claude-sonnet-5`, `gpt-5.6-terra`, `xai/grok-4.5` |
| `version` | Derived from the id | `5.0`, `4.5-20251101` |

VS Code asks the user for consent the first time an extension sends a request. Pass a `justification` in the request options to explain the need:

```ts
await model.sendRequest(messages, {
    justification: 'Generating a commit message from the staged diff.',
});
```

### Tool calling

Pass `tools` in the request options and read `LanguageModelToolCallPart` values from `response.stream` rather than `response.text`:

```ts
const response = await model.sendRequest(
    messages,
    {
        tools: [
            {
                name: 'read_file',
                description: 'Read a file from the workspace',
                inputSchema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
            },
        ],
        toolMode: vscode.LanguageModelChatToolMode.Auto,
    },
    cancellationToken
);

for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
        // Invoke the tool, then send the result back as a
        // LanguageModelToolResultPart on a follow-up User message.
    }
}
```

`LanguageModelChatToolMode.Required` maps to `tool_choice: "required"`; `Auto` maps to `"auto"`.

### Passing provider-specific options

Values in `modelOptions` are forwarded to the endpoint unchanged, which allows any parameter the underlying model accepts:

```ts
await model.sendRequest(messages, {
    modelOptions: {
        temperature: 0.2,
        max_tokens: 4096,
        reasoning_effort: 'high',
    },
});
```

`model`, `messages`, `stream`, `tools`, and `tool_choice` cannot be overridden this way. They are applied after `modelOptions` because replacing them would break response handling.

## How it works

### Model discovery

Discovery runs when VS Code asks for the model list, not at activation, so an unconfigured extension costs nothing at startup.

1. `GET {baseUrl}/models` with `Authorization: Bearer <key>` returns the ids the key can reach. This is the authoritative list.
2. `GET https://router.tetrate.ai/api/public/models?limit=500` returns metadata for the public catalog: display names, context windows, output limits, and capabilities.
3. The two are joined by model id, non-conversational models are dropped, `modelFilter` is applied, and the result is sorted by display name.

The result is cached against the base URL and filter. Changing the key, the base URL, or the filter clears the cache and fires `onDidChangeLanguageModelChatInformation`, prompting VS Code to re-query.

Step 2 is best-effort. If `router.tetrate.ai` is unreachable, for example behind a proxy that blocks it, discovery still succeeds using fallback limits.

### Why two endpoints

The OpenAI-compatible `/models` route reports only ids, with no context window, output limit, or vision flag. VS Code needs all three to populate `LanguageModelChatInformation`. The public catalog supplies them.

Models absent from the catalog fall back to conservative values:

| Property | Fallback | Reasoning |
| --- | --- | --- |
| Context window | 128,000 tokens | An overstated window fails mid-conversation; an understated one only wastes headroom. |
| Max output | 16,384 tokens | Same reasoning. |
| Tool calling | Assumed supported | An uncatalogued model is more likely capable than not. |
| Image input | Assumed unsupported | Sending an image to a text-only model is a hard error. |

Context window and output limit are reported separately to VS Code, so the output budget is subtracted from the context window to give `maxInputTokens`.

### Which models are offered

The catalog's `mode` field decides. These modes are excluded because they cannot answer a chat request:

`embedding`, `image_generation`, `rerank`, `moderation`, `audio_transcription`, `audio_speech`

Every other mode is offered, including unrecognized future ones. `mode: "responses"` matters here: it records that the upstream provider's native API is OpenAI's Responses API, and every OpenAI model is listed that way. The Agent Router still serves those models over the OpenAI-compatible chat-completions route, so excluding them would drop the entire OpenAI line-up.

For models the catalog does not describe, an id pattern filters obvious embedding and rerank models instead.

### Request translation

VS Code and the OpenAI protocol disagree on where tool results live. VS Code attaches a `LanguageModelToolResultPart` to a user message; the OpenAI protocol expects a standalone `tool` message following the assistant turn that requested it. Tool results are therefore emitted before the remaining user content, preserving the assistant → tool → user ordering the API validates.

Other translation details:

- Only `User` and `Assistant` roles exist in the provider API. A system prompt arrives as the first user message and is passed through as one.
- Assistant content is flattened to text, because the OpenAI protocol has no multi-part assistant content. Images in a replayed assistant turn are dropped rather than sent in an invalid shape.
- Images become `image_url` parts carrying a base64 data URL.
- An empty tool result is sent as `(no output)`, because the API rejects a `tool` message with empty content.
- Messages with no usable content are skipped, and an assistant turn that only calls tools omits `content` rather than sending an empty string.

### Streaming and cancellation

Responses stream over server-sent events. Text deltas are reported as they arrive. Tool calls are accumulated by index across chunks, since `id`, `name`, and `arguments` may each be split, and are reported once the stream completes. Unparseable tool arguments become an empty object so the tool itself can report a validation failure rather than failing the whole turn.

Cancelling a request aborts the underlying HTTP request. An aborted request completes quietly instead of surfacing an error.

### Token counting

Counts are estimated locally. The endpoint exposes no token-counting route, and the models behind it use at least three different tokenizers.

| Constant | Value | Meaning |
| --- | --- | --- |
| `CHARS_PER_TOKEN` | 3.5 | Divisor for text |
| `TOKENS_PER_MESSAGE` | 4 | Per-message protocol overhead |
| `TOKENS_PER_IMAGE` | 800 | Flat cost for an image |

The divisor is deliberately pessimistic. Roughly 4 characters per token holds for prose but falls to about 2.5 on dense source code, and undercounting would let a caller overfill its budget and hit a hard API error. Overcounting only leaves some context unused.

Image cost is a flat estimate, since real cost scales with resolution and computing it would require decoding the image.

## Behaviour and limitations

- **Output length.** No token cap is sent, so each model's server-side default applies. Sending `max_tokens` unconditionally risks rejection on models that require `max_completion_tokens` instead. Set either through `modelOptions`.
- **Images** are sent only for models reporting vision support. Audio and PDF inputs are not forwarded, because the chat-completions content model this endpoint exposes has no place for them.
- **Reasoning traces** are not surfaced. The provider response part types have no thinking part in the supported VS Code versions.
- **Prompt caching** is not configured explicitly. Where the upstream provider applies it automatically, it still takes effect.
- **Retries** follow the OpenAI SDK default of two attempts on transient failures.
- **Rate limits and errors** propagate as-is. A 401 or 403 becomes a `LanguageModelError.NoPermissions`, a 404 becomes `NotFound`, and everything else surfaces with the status and the server's message.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No models in the picker | Models start hidden. Run **Chat: Manage Language Models** and enable them. |
| No models after enabling | Check the key with **Set Agent Router API Key**, then **Refresh Model List**. |
| Models missing after editing settings | `modelFilter` may exclude them. An empty array offers everything. |
| A 401 on every request | The key is invalid or revoked. Set a fresh one from the dashboard. |
| A 404 on every request | The base URL is wrong. It must end in `/v1` or another version segment. |
| Fallback limits on every model | `router.tetrate.ai` is unreachable, so catalog metadata is unavailable. Discovery still works. |
| Stale icon or old behaviour after reinstall | Quit VS Code fully and reopen. Window reload does not clear the icon cache. |
| Claude models appear twice | Another Claude provider extension is installed. Both contribute under separate vendors. |

The **Tetrate Agent Router** output channel logs the discovered model count, configuration changes, and failures with status codes. Open it from **View → Output** and pick the channel from the dropdown. It never logs the API key or message content.

## Development

### Project layout

```text
src/
├── extension.ts        Activation, command registration, provider registration
├── provider.ts         LanguageModelChatProvider: discovery, streaming, tool calls
├── catalog.ts          Model fetching, catalog join, LanguageModelChatInformation mapping
├── messages.ts         VS Code chat parts ↔ OpenAI chat-completion messages
├── tokenCount.ts       Local token estimation
├── config.ts           Settings access, base URL normalization, glob matching
├── secrets.ts          API key storage and prompting
└── test/
    ├── vscodeMock.ts       Stand-in for the vscode module
    └── integration.test.ts Opt-in tests against the live service
scripts/
└── build-icon.mjs      Rasterizes images/logo.svg to images/icon.png
```

### Scripts

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run bundle      # esbuild -> out/extension.js
npm run package     # vsce package -> .vsix
npm run icon        # regenerate images/icon.png
```

### Testing

The unit suite runs offline. `vscode` is aliased to `src/test/vscodeMock.ts`, a hand-written stand-in implementing only the surface the tested code touches, because the real module exists only inside the extension host.

Tests that hit the real service are opt-in:

```bash
TARS_INTEGRATION=1 npm test                             # public catalog only
TARS_INTEGRATION=1 AGENTROUTER_API_KEY=sk-... npm test  # also GET /v1/models
```

The integration tests assert properties that would silently degrade the extension if upstream changed: that the OpenAI line-up is still offered, that embedding and image models are not, and that every offered model maps to positive input and output budgets.

### Debugging

Press <kbd>F5</kbd> to launch an extension-host window. The **Tetrate Agent Router** output channel carries discovery and request logging.

`@types/vscode` is pinned to exactly `1.106.0` rather than a caret range, so typecheck enforces the declared engine floor instead of allowing APIs from newer versions to compile.

### The icon

`npm run icon` rasterizes `images/logo.svg` to a 256×256 `images/icon.png` using `@resvg/resvg-js`. `images/logo.svg` is a verbatim copy of the Tetrate mark at <https://docs.tetrate.ai/img/logo.svg>. The mark is portrait, so the script reads its `viewBox`, scales it to fit a square canvas with a margin, and centers it. To pick up an upstream logo change, replace that file and re-run the script.

## Privacy

Prompts, file contents, and tool results are sent to the configured base URL, which forwards them to the upstream model provider. With the default base URL, that is Tetrate Agent Router Service and whichever provider serves the selected model. Their terms and retention policies apply.

One additional request goes to `router.tetrate.ai/api/public/models` to read model metadata. It is unauthenticated and carries no prompt content or API key.

The API key is sent as a bearer token to the configured base URL only.

## License

Apache-2.0. See [LICENSE](LICENSE).

Usage is billed to the configured Agent Router account at that service's rates.
