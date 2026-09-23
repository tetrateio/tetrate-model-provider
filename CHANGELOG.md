# Changelog

## Unreleased

A richer surface for the stats and the model list. No settings changed, and no action is needed on upgrade.

### Added

- A usage dashboard. **Show Session Usage** now opens a panel with a daily spend chart over the retained 62 days, a per-model breakdown switchable between 7, 30, and 62 days, and the session table. The panel updates live while requests complete, and a projection line estimates today's final spend from the intraday rate alongside the trailing seven-day average. The same figures are still written to the output channel.
- A richer status bar hover. The per-model session table, today's and the last seven days' totals, and links to the dashboard and the model chooser are shown on hover instead of requiring a command. When `spendWarning` is set, the status bar item turns to the warning colour at 80% of the threshold and to the error colour past it. While a request streams, the item shows a spinner with the model and the elapsed time. Clicking the item opens a command menu; the dashboard, the model chooser, and the setup commands are one pick away.
- An **Overview** view in the activity bar: the endpoint, key, catalog, and profile status with one-click actions, every reachable model grouped by provider with a checkbox that edits the model filter in place, and the session, today, and seven-day usage. Model rows show the median time to first output once requests have been made, and an inline action opens the chat view. When no key is stored, the view shows the onboarding buttons instead. A **Recent Requests** view below it lists the last 50 completed requests with their tokens, cost, duration, and finish reason.
- A better **Choose Models** picker. Models are grouped under provider separators, tool and vision support is marked with icons, the context window is shown alongside the price, and two title buttons select or clear everything at once.
- A `@tetrate` chat participant. `/usage` reports today's and the session's figures in the chat view, `/models` finds offered models by capability, price, or name (`@tetrate /models vision under $1`), and `/switch` changes to a named endpoint profile.
- A **Test Connection** command that sends a one-token completion to the first offered model and reports the round trip, so a fresh setup is confirmed end to end rather than only by listing models.
- **Add Endpoint Profile** and **Remove Endpoint Profile** commands, so profiles no longer require hand-editing a settings object. The Overview view lists them with the current one marked.

## 0.5.0

Usage visibility and per-model control. No existing settings changed, and no action is needed on upgrade.

### Added

- Token usage and cost tracking. The billed token counts are requested with every streamed response and accumulated per model for the session. The status bar shows the running session cost, or the token count when no price is known, and **Show Session Usage** prints the per-model breakdown. Each completed request is also logged with its counts and cost. Costs are computed from the public catalog's prices; a request whose model has no known price is still counted and is reported as unpriced.
- Prices in the model picker. A model with known pricing shows its input and output price per million tokens in the picker detail and in the tooltip, and reasoning models are marked in the tooltip.
- A `modelOverrides` setting, keyed by the same glob patterns as `modelFilter`. `contextWindow` and `maxOutputTokens` replace catalog values, which gives real budgets to models the public catalog does not describe. `temperature` and `reasoningEffort` are sent with every request to matching models and take precedence over a calling extension's `modelOptions`.
- A **Show Connection Status** command. The extension version, the base URL, whether a key is stored, a live check of the models endpoint with reachable and offered counts, and the age of the cached catalog are reported in one place.
- Images returned by tools are forwarded to models that accept image input. A `tool` message is text only in the OpenAI protocol, so each image travels in the user message that follows it, with a note in the tool text marking where it went. Text-only models keep the previous placeholder, and an agent that captures screenshots can now have them seen.
- Usage history that survives reloads. Daily aggregates are kept for 62 days, and **Show Session Usage** now reports today and the last seven days alongside the session. A `spendWarning` setting raises one warning per window when the day's estimated cost passes a dollar threshold.
- A `profiles` setting naming endpoints, and a **Switch Endpoint** command that switches between them from a quick pick. Each endpoint keeps its own API key.
- A **Choose Models** command that edits the model filter from a checkbox list of every model the key can reach, instead of hand-written glob patterns. Selecting everything clears the filter.
- A `maxTokens` field in `modelOverrides`, sent as `max_tokens` with every request to matching models. Unlike `maxOutputTokens`, which only adjusts the advertised budget, this is a hard output cap for cost control.
- Request timing in the log. Every completed request logs its time to first output and total duration alongside the token counts, and a completion with no usage block is now logged too.
- A getting-started walkthrough (create a key, store it, enable models), a management command on the provider's row in the Language Models editor, and **Open Dashboard** actions on the messages shown when no key is stored.

### Changed

- API keys are stored per endpoint host. Switching the base URL between the hosted service and a self-hosted deployment previously sent the one stored key to whichever host was configured. A key stored by an earlier version keeps working as a fallback until a per-host key is saved, so nothing needs re-entering on upgrade; **Clear Agent Router API Key** removes the key for the configured endpoint along with the old unscoped one.
- Models the public catalog marks disabled are no longer offered, since requests to them fail even when `/models` still lists them.

## 0.4.0

Correctness fixes to model budgets and streaming, and unit tests for the streaming path. No settings changed, and no action is needed on upgrade.

### Fixed

- Models whose catalog entry advertises an output cap as large as their context window, such as `gpt-4` and the `gpt-oss` family, were offered with a prompt budget of 1,024 tokens and were unusable from chat. The output reservation is now capped at half the window, so `gpt-4` reports 4,096 input and 4,096 output tokens and `gpt-oss-120b` reports 65,536 of each. No other model's budgets change.
- A response that produced no output for sixty seconds was reported as stalled. Reasoning models stream nothing while they think, and a high-effort request on a long prompt can take longer than that. The first output now has a three-minute allowance, and the sixty-second rule applies only between chunks once output has started.
- A stall or a cancellation that arrived mid-stream was not reported at all. The OpenAI SDK ends its stream iterator quietly when the request is aborted after the first chunk, so the turn finished as though the truncated answer were complete, and any tool calls collected so far were still dispatched. Both cases are now checked after the stream ends: a stall raises an error and a cancellation returns without reporting anything further.
- Tool results rendered with `@vscode/prompt-tsx`, which VS Code's built-in tools produce, were sent upstream as `(no output)` and counted as zero tokens. They are now serialized to JSON text and counted accordingly.
- A gateway that repeats the full tool name on every streamed chunk produced names such as `read_fileread_file`. The name is now taken from the latest chunk, matching the OpenAI SDK's own accumulator; arguments are still concatenated.
- Tool arguments that parse as a JSON array were accepted as valid input. They now take the same path as unparseable arguments: an empty object, with the offending text logged.
- The public catalog was read one page at a time and only the first page was used. Additional pages are now fetched when the catalog reports more than one.

### Release process

- The GitHub release and its VSIX are now created before the Marketplace publish step, so a Marketplace authentication failure no longer leaves the tag without a downloadable package. This is what left v0.3.0 without a GitHub release.
- The README's local VSIX link points at the current release.

## 0.3.0

A reliability and speed pass over model discovery and streaming. No settings changed, and no action is needed on upgrade.

### Reliability

- Both requests behind model discovery now have a deadline. A host that accepted the connection and then went quiet — a stalled proxy, a captive portal — previously left the model picker spinning indefinitely, because neither `fetch` nor VS Code imposes a limit of its own.
- `GET /v1/models` makes up to three attempts on a transient failure (408, 425, 429, 5xx, or a dropped connection) with exponential backoff, honouring a short `Retry-After`. A single rate-limit response no longer empties the model list. An authentication failure is still reported on the first attempt.
- A response that stalls for 60 seconds mid-stream is reported as a stall, rather than hanging until the request is cancelled.
- A truncated or filtered answer is no longer indistinguishable from a complete one. Reaching the output token limit appends a note and logs the limit; a content filter that blocks a request raises an error instead of returning nothing.
- Failures that a gateway reports as a field on a stream chunk, rather than by closing the connection, are raised instead of read as a short answer.
- A non-JSON reply to `GET /v1/models`, typically a proxy sign-in page, is reported with the URL and content type in place of a bare JSON parser error.
- A model advertising an output cap as large as its whole context window no longer has both budgets reported in full, which overcommitted the window and failed at request time.
- Tool arguments that will not parse are logged with the offending text. The call still proceeds with an empty object, as before.
- Ids synthesized for a gateway that omits them are unique across turns, not only within one response.
- The model list is refreshed after fifteen minutes, so a model added upstream appears without a window reload.
- The secret-storage listener reacts only to this extension's API key, and bursts of invalidation — one per keystroke while editing `settings.json` — are collapsed into a single refresh.

### Speed

- The public catalog is cached for a day, which removes a network round trip from every start after the first. When the catalog cannot be reached, a stale copy is preferred over the fallback defaults, so an offline window still gets real context windows rather than conservative guesses. **Refresh Model List** discards it.
- Overlapping model-discovery calls share one pair of requests. VS Code asks from several places at startup, which previously meant a request per caller.
- The API key is read from secret storage once per change instead of before every request.
- Attachments are measured by byte length rather than decoded in full purely to count characters.
- Filter patterns are compiled once instead of once per model per listing.

## 0.2.0

First release submitted to the Visual Studio Code Marketplace.

- **Breaking.** `tetrate-model-provider.baseUrl` and `tetrate-model-provider.requestHeaders` are now machine-scoped and can only be set in User settings. Both influence where the API key is sent, and a workspace `.vscode/settings.json` was previously able to change them. Move any workspace-level value to User settings.
- An `Authorization` entry in `requestHeaders` is now discarded rather than overriding the key from secret storage.
- Declared support for untrusted workspaces and virtual workspaces, so the extension stays enabled in Restricted Mode and in remote or virtual file system windows.
- Declared `extensionKind` as `ui` first, keeping the API key and outbound requests on the local machine in remote development windows.
- The published bundle no longer references a source map that was not shipped.

## 0.1.1

- Use the Tetrate mark from <https://docs.tetrate.ai/img/logo.svg> as the extension icon.

## 0.1.0

Initial release.

- Contributes chat models from Tetrate Agent Router Service under the `tetrate-agent-router` vendor, for the chat view and for other extensions using `vscode.lm`.
- Discovers models from the endpoint at runtime and enriches them with context window, output limit, and vision support from the public Agent Router catalog.
- Stores the Agent Router API key in VS Code secret storage, prompting when a model list is resolved interactively.
- Base URL pre-configured to `https://api.router.tetrate.ai/v1` and overridable via the `tetrate-model-provider.baseUrl` setting or the **Set Base URL** command.
- Streaming responses, tool calling, image input, cancellation, and local token estimation.
- Optional model filtering by glob pattern and extra request headers.
