# Changelog

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
