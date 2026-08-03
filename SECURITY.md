# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/tetrateio/tetrate-model-provider/security/advisories/new) rather than a public issue.

Include the extension version, the VS Code version, and the steps needed to reproduce.

## Scope

This extension holds an Agent Router API key and sends it to a configured endpoint. Reports about key handling, about settings that influence where the key is sent, and about content leaving the machine unexpectedly are in scope.

The Agent Router service itself is out of scope here; report those to Tetrate directly.

## Design notes

- The API key lives in VS Code [secret storage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), never in a settings file. On macOS that is the system Keychain.
- `baseUrl` and `requestHeaders` decide where the key is sent, so both are machine-scoped and cannot be set from a workspace or folder `settings.json`. Opening an untrusted repository cannot redirect the key.
- An `Authorization` entry in `requestHeaders` is discarded. That header is always derived from the stored key.
- The output channel logs model counts, configuration changes, and failure status codes. It never logs the key or message content.
- One unauthenticated request goes to `router.tetrate.ai/api/public/models` for model metadata. It carries no key and no prompt content.
