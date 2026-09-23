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

1. Download [tetrate-model-provider-0.5.0.vsix](https://github.com/tetrateio/tetrate-model-provider/releases/download/v0.5.0/tetrate-model-provider-0.5.0.vsix) from the [Github repo](https://github.com/tetrateio/tetrate-model-provider).
1. Install from command line using `code`:

```bash
code --install-extension tetrate-model-provider-0.5.0.vsix
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

The same three steps are available as a walkthrough under **Help → Get Started**, titled **Get started with Tetrate Agent Router**.

### Where the key is stored

The key is held in VS Code [secret storage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), scoped to the endpoint host: `tetrate-model-provider.agentRouterApiKey:<host>`. It is never written to a settings file, a log, or the output channel. On macOS that means the system Keychain.

Scoping by host keeps each credential with its endpoint. When the base URL is switched between the hosted service and a self-hosted deployment, each host keeps its own key, and a key entered for one host is never sent to another. A key stored by a version before scoping serves as a fallback for any host until a scoped key is saved.

Secret storage is per-machine and does not sync across Settings Sync.

## Configuration

| Setting | Type | Default | Scope | Purpose |
| --- | --- | --- | --- | --- |
| `tetrate-model-provider.baseUrl` | string | `https://api.router.tetrate.ai/v1` | machine | The OpenAI-compatible endpoint to call. |
| `tetrate-model-provider.modelFilter` | string[] | `[]` | window | Glob patterns limiting which models are offered. Empty offers every chat model. |
| `tetrate-model-provider.modelOverrides` | object | `{}` | window | Per-model budgets and request defaults, keyed by glob pattern. |
| `tetrate-model-provider.requestHeaders` | object | `{}` | machine | Extra HTTP headers sent with every request. |
| `tetrate-model-provider.profiles` | object | `{}` | machine | Named endpoints for the **Switch Endpoint** command. |
| `tetrate-model-provider.sessionAttribution` | boolean | `false` | window | Send a per-window `agent-session-id` header, recorded by the gateway as a trace attribute. |
| `tetrate-model-provider.spendWarning` | number | `0` | window | Warn once the day's estimated cost reaches this many dollars. `0` disables it. |

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

Endpoints that are switched between regularly belong in `profiles`, after which **Tetrate Agent Router: Switch Endpoint** changes between them from a quick pick. Each endpoint keeps its own API key, so switching never sends one host's credential to another:

```jsonc
{
    "tetrate-model-provider.profiles": {
        "Production": "https://api.router.tetrate.ai/v1",
        "Staging": "https://router.tare-staging.tetrate.ai/v1"
    }
}
```

### Filtering the model list

The hosted catalog currently exposes more than 160 conversational models. To keep the picker manageable, restrict it by glob pattern:

```jsonc
{
    "tetrate-model-provider.modelFilter": ["claude-*", "gpt-5.6-*", "gemini-3.1-pro-preview"]
}
```

Only `*` is special and it matches within and across segments. Everything else, including `.` and `-`, compares literally, and matching is case-insensitive. A model is offered when it matches at least one pattern.

**Tetrate Agent Router: Choose Models** edits the same setting from a checkbox list of every model the key can reach, grouped by provider, with tool and vision support marked by icons and the context window shown alongside the price. Two title buttons select or clear everything at once. The selection is written as exact ids, replacing any glob patterns; selecting everything clears the filter, which keeps newly added upstream models appearing on their own.

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

### Per-model overrides

`modelOverrides` tunes individual models. Entries are keyed by the same `*` glob patterns as `modelFilter`; when several patterns match one model, later entries win field by field.

```jsonc
{
    "tetrate-model-provider.modelOverrides": {
        "claude-*": { "reasoningEffort": "high" },
        "in-house-llama": { "contextWindow": 1000000, "maxOutputTokens": 32768 }
    }
}
```

| Field | Effect |
| --- | --- |
| `contextWindow` | Replaces the catalog's context window when the token budgets are computed. |
| `maxOutputTokens` | Replaces the catalog's output limit in the advertised budget. Nothing is sent with the request. |
| `maxTokens` | A hard output cap, sent as `max_tokens` with every request. Some OpenAI reasoning models reject `max_tokens` in favour of `max_completion_tokens`; for those, use `modelOptions` instead. |
| `temperature` | Sent with every request to matching models. 0 to 2. |
| `reasoningEffort` | Sent as `reasoning_effort` with every request. One of `minimal`, `low`, `medium`, `high`. Only meaningful for reasoning models. |

The budget fields exist for deployments the public catalog does not describe, where the conservative fallback limits would waste most of a large context window. The request fields take precedence over a calling extension's `modelOptions`, since a setting records the user's own choice.

## Session usage and cost

The billed token counts are requested with every streamed response, accumulated per model, and combined with the public catalog's prices:

- The status bar shows the running session cost after the first completed request, or the token count when no price is known, and a spinner with the model and elapsed time while a request streams. Hovering it shows the per-model table, today's and the last seven days' totals, and links to the dashboard; clicking it opens a command menu with the dashboard, the model chooser, and the setup commands.
- **Tetrate Agent Router: Show Session Usage** opens the usage dashboard: a daily spend chart over the retained 62 days, a per-model breakdown switchable between 7, 30, and 62 days, and the session table, updating live as requests complete. A projection line estimates today's final spend from the intraday rate. The same lines are still written to the output channel.
- Each completed request is logged to the output channel with its counts, cost, time to first output, and total duration.

Daily aggregates are kept in extension storage for 62 days, so today's figure spans window reloads. When `spendWarning` is set, one warning per window is raised once today's estimated cost reaches the threshold, which puts a brake on a runaway agent session; the status bar item also takes the warning colour at 80% of the threshold and the error colour past it.

Models with known prices also show them in the model picker, as dollars per million input and output tokens.

Costs are estimates computed from the public catalog's current prices; the Agent Router dashboard is the billing authority. A model absent from the catalog is counted but reported as having no known price. Two windows recording at the same moment can undercount, since each writes its own copy of the day's totals.

## Commands

| Command | Description |
| --- | --- |
| Tetrate Agent Router: Set Agent Router API Key | Store or replace the API key. |
| Tetrate Agent Router: Clear Agent Router API Key | Remove the stored key for the configured endpoint. |
| Tetrate Agent Router: Set Base URL | Change the endpoint, with validation. |
| Tetrate Agent Router: Refresh Model List | Discard the cached model list and re-query the endpoint. |
| Tetrate Agent Router: Show Session Usage | Open the usage dashboard with the daily spend chart and per-model breakdowns. |
| Tetrate Agent Router: Show Connection Status | Check the endpoint, the key, and the catalog cache in one report. |
| Tetrate Agent Router: Switch Endpoint | Change the base URL from the profiles quick pick. |
| Tetrate Agent Router: Choose Models | Edit the model filter from a checkbox list of reachable models. |
| Tetrate Agent Router: Command Menu | The status bar menu: dashboard, models, endpoint, and setup in one pick. |
| Tetrate Agent Router: Test Connection | Send a one-token completion and report the round trip. |
| Tetrate Agent Router: Add Endpoint Profile | Name and store an endpoint for the Switch Endpoint command. |
| Tetrate Agent Router: Remove Endpoint Profile | Remove a stored endpoint profile. |

## The Overview view

A **Tetrate Agent Router** icon in the activity bar opens the Overview view, which gathers the moving parts in one place:

- **Endpoint**: the base URL with its profile name, the gateway's own health, per-provider health from the gateway's observation window, the key status, the catalog age, and the configured profiles with the current one marked. Each row is clickable and runs the matching command, and profiles are added and removed from here.
- **Models**: every model the key can reach, grouped by provider, with the id and context window on each row. The checkbox on each row edits the model filter in place, a family checkbox toggles the whole group, and once requests have been made a row shows its median time to first output. A provider the gateway reports failing is marked on its families and models. An inline action opens the chat view.
- **Usage**: the session, today, and the last seven days. Each row opens the dashboard.

A **Recent Requests** view below it lists the last 50 completed requests, newest first, with tokens, cost, duration, an icon marking truncated or filtered answers, and a `via <backend>` marker when fallback routing or a model-name override answered with a different backend. An inline action copies the request id, which finds the request in the Console's Request Logs. When a request fails, the output channel logs a triage verdict: whether the gateway itself, an upstream provider, or neither is the problem.

When no API key is stored for the configured endpoint, the view shows the setup buttons instead. **Tetrate Agent Router: Test Connection** confirms a fresh setup end to end by sending a one-token completion and reporting the round trip.

## The @tetrate chat participant

The extension registers a `@tetrate` participant in the chat view for operational questions:

```text
@tetrate /usage                        today, the last seven days, and the session
@tetrate /models vision under $1       offered models by capability, price, or name
@tetrate /switch Staging               change to a named endpoint profile
```

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

`model`, `messages`, `stream`, `stream_options`, `tools`, and `tool_choice` cannot be overridden this way. They are applied after `modelOptions` because replacing them would break response handling. A `temperature` or `reasoningEffort` set in the user's `modelOverrides` setting also takes precedence over `modelOptions`.

## How it works

### Model discovery

Discovery runs when VS Code asks for the model list, not at activation, so an unconfigured extension costs nothing at startup.

1. `GET {baseUrl}/models` with `Authorization: Bearer <key>` returns the ids the key can reach. This is the authoritative list.
2. `GET https://router.tetrate.ai/api/public/models?limit=500` returns metadata for the public catalog: display names, context windows, output limits, and capabilities. When the catalog spans more than one page, the remaining pages are fetched as well.
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

Context window and output limit are reported separately to VS Code, so the output budget is subtracted from the context window to give `maxInputTokens`. The amount reserved for output is capped at half the window. A few catalog entries advertise an output cap as large as their whole context window, and reserving all of it would leave no room for the prompt. The output figure is informational in any case, since no token cap is sent with the request.

### Which models are offered

The catalog's `mode` field decides. These modes are excluded because they cannot answer a chat request:

`embedding`, `image_generation`, `rerank`, `moderation`, `audio_transcription`, `audio_speech`

Every other mode is offered, including unrecognized future ones. `mode: "responses"` matters here: it records that the upstream provider's native API is OpenAI's Responses API, and every OpenAI model is listed that way. The Agent Router still serves those models over the OpenAI-compatible chat-completions route, so excluding them would drop the entire OpenAI line-up.

A model the catalog marks disabled is excluded as well, since `/models` can lag the catalog and requests to a disabled model fail.

For models the catalog does not describe, an id pattern filters obvious embedding and rerank models instead.

### Request translation

VS Code and the OpenAI protocol disagree on where tool results live. VS Code attaches a `LanguageModelToolResultPart` to a user message; the OpenAI protocol expects a standalone `tool` message following the assistant turn that requested it. Tool results are therefore emitted before the remaining user content, preserving the assistant → tool → user ordering the API validates.

Other translation details:

- Only `User` and `Assistant` roles exist in the provider API. A system prompt arrives as the first user message and is passed through as one.
- Assistant content is flattened to text, because the OpenAI protocol has no multi-part assistant content. Images in a replayed assistant turn are dropped rather than sent in an invalid shape.
- Images become `image_url` parts carrying a base64 data URL.
- A tool result rendered with `@vscode/prompt-tsx`, as VS Code's built-in tools produce, is serialized to JSON text, since the model cannot consume the element tree directly.
- An image returned by a tool cannot ride in a `tool` message, which the protocol keeps text only. For a model that accepts image input it is attached to the user message that follows, with a note in the tool text marking where it went; for a text-only model it is named in place.
- An empty tool result is sent as `(no output)`, because the API rejects a `tool` message with empty content.
- Messages with no usable content are skipped, and an assistant turn that only calls tools omits `content` rather than sending an empty string.

### Streaming and cancellation

Responses stream over server-sent events. Text deltas are reported as they arrive. Tool calls are accumulated by index across chunks, since `arguments` arrive as string fragments, and are reported once the stream completes. Arguments that do not parse as a JSON object become an empty object so the tool itself can report a validation failure rather than failing the whole turn.

Two timeouts guard the stream. A response that produces no output for three minutes is reported as an error; the allowance is long because reasoning models stream nothing while they think. Once output has started, a gap of sixty seconds between chunks is reported as a stall. Both surface in the chat view and in the output channel.

The billed token counts are requested with `stream_options.include_usage` and arrive on a final chunk that carries no content. They feed the session usage tracking; a gateway that omits the block leaves the request uncounted rather than counted as zero.

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

- **Output length.** No token cap is sent by default, so each model's server-side default applies. Sending `max_tokens` unconditionally risks rejection on models that require `max_completion_tokens` instead. A per-model cap is set with `maxTokens` in `modelOverrides`, or either parameter through `modelOptions`.
- **Images.** VS Code offers image attachments only for models that report vision support. The provider forwards every image part it receives as a base64 data URL and does not check the capability itself, except for images inside tool results, which are forwarded only to models that report image input. Audio and PDF inputs are not forwarded, because the chat-completions content model this endpoint exposes has no place for them.
- **Reasoning traces** are not surfaced. The provider response part types have no thinking part in the supported VS Code versions. A default `reasoning_effort` can be set per model through `modelOverrides`, and reasoning tokens are reported in the usage breakdown.
- **Prompt caching** is not configured explicitly. Where the upstream provider applies it automatically, it still takes effect.
- **Retries** follow the OpenAI SDK default of two retries on transient failures, for three attempts in total. A retry happens only before the stream opens, so a partially delivered answer is never re-requested.
- **Rate limits and errors** propagate as-is. A 401 or 403 becomes a `LanguageModelError.NoPermissions`, a 404 becomes `NotFound`, and everything else surfaces with the status and the server's message.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No models in the picker | Models start hidden. Run **Chat: Manage Language Models** and enable them. |
| No models after enabling | Check the key with **Set Agent Router API Key**, then **Refresh Model List**. |
| Models missing after editing settings | `modelFilter` may exclude them. An empty array offers everything. |
| A 401 on every request | The key is invalid or revoked. Set a fresh one from the dashboard. |
| A 404 on every request | The base URL is wrong. It must end in `/v1` or another version segment. |
| Fallback limits on every model | `router.tetrate.ai` is unreachable, so catalog metadata is unavailable. Discovery still works. Real budgets can be pinned through `modelOverrides`. |
| Usage reports "price unknown" | The model is absent from the public catalog, so no price is known. Tokens are still counted. |
| No usage in the status bar | The gateway did not return a usage block on the stream. Counting needs an endpoint that honours `stream_options.include_usage`. |
| "produced no output for 180s" | The model sent nothing for three minutes. A reasoning model on a very long prompt can take this long; lower the reasoning effort through `modelOverrides` or `modelOptions`, shorten the prompt, or pick a faster model. |
| "stalled for 60s with no data" | The stream stopped mid-answer. Usually a gateway or network interruption; retry the request. |
| Stale icon or old behaviour after reinstall | Quit VS Code fully and reopen. Window reload does not clear the icon cache. |
| Claude models appear twice | Another Claude provider extension is installed. Both contribute under separate vendors. |

The **Tetrate Agent Router** output channel logs the discovered model count, configuration changes, and failures with status codes. Open it from **View → Output** and pick the channel from the dropdown. It never logs the API key or message content.

## Privacy

Prompts, file contents, and tool results are sent to the configured base URL, which forwards them to the upstream model provider. With the default base URL, that is Tetrate Agent Router Service and whichever provider serves the selected model. Their terms and retention policies apply.

One additional request goes to `router.tetrate.ai/api/public/models` to read model metadata. It is unauthenticated and carries no prompt content or API key.

The API key is sent as a bearer token to the configured base URL only.

## License

Apache-2.0. See [LICENSE](LICENSE).

Usage is billed to the configured Agent Router account at that service's rates.
