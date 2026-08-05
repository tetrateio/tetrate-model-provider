# Development

## Project layout

```text
src/
├── extension.ts        Activation, command registration, provider registration
├── provider.ts         LanguageModelChatProvider: discovery, streaming, tool calls
├── catalog.ts          Model fetching, catalog join, LanguageModelChatInformation mapping
├── catalogCache.ts     Day-long persistence of the public catalog in globalState
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

## Scripts

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run bundle      # esbuild -> out/extension.js
npm run package     # vsce package -> .vsix
npm run icon        # regenerate images/icon.png
```

## Testing

The unit suite runs offline. `vscode` is aliased to `src/test/vscodeMock.ts`, a hand-written stand-in implementing only the surface the tested code touches, because the real module exists only inside the extension host.

Tests that hit the real service are opt-in:

```bash
TARS_INTEGRATION=1 npm test                             # public catalog only
TARS_INTEGRATION=1 AGENTROUTER_API_KEY=sk-... npm test  # also GET /v1/models
```

The integration tests assert properties that would silently degrade the extension if upstream changed: that the OpenAI line-up is still offered, that embedding and image models are not, and that every offered model maps to positive input and output budgets.

## Debugging

Press <kbd>F5</kbd> to launch an extension-host window. The **Tetrate Agent Router** output channel carries discovery and request logging.

`@types/vscode` is pinned to exactly `1.106.0` rather than a caret range, so typecheck enforces the declared engine floor instead of allowing APIs from newer versions to compile.

## The icon

`npm run icon` rasterizes `images/logo.svg` to a 256×256 `images/icon.png` using `@resvg/resvg-js`. `images/logo.svg` is a verbatim copy of the Tetrate mark at <https://docs.tetrate.ai/img/logo.svg>. The mark is portrait, so the script reads its `viewBox`, scales it to fit a square canvas with a margin, and centers it. To pick up an upstream logo change, replace that file and re-run the script.
