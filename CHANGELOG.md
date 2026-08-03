# Changelog

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
