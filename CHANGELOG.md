# Changelog

## 0.3.0

A reliability and speed pass over model discovery and streaming. No settings changed, and no action is needed on upgrade.

### Reliability

- Both requests behind model discovery now have a deadline. A host that accepted the connection and then went quiet — a stalled proxy, a captive portal — previously left the model picker spinning indefinitely, because neither `fetch` nor VS Code imposes a limit of its own.
- `GET /v1/models` retries a transient failure — 408, 425, 429, 5xx, or a dropped connection — up to three times with exponential backoff, honouring a short `Retry-After`. A single rate-limit response no longer empties the model list. An authentication failure is still reported on the first attempt.
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
