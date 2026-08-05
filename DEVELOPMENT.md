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

## Releasing

A release is a tag push. `.github/workflows/release.yml` typechecks, lints, tests, checks the tag against `package.json`, packages the VSIX, publishes it to the Marketplace, and attaches it to the GitHub release.

```bash
npm version minor --no-git-tag-version   # major, minor or patch
# update CHANGELOG.md, then commit both
git tag v0.4.0 && git push origin master v0.4.0
```

Running the workflow from the Actions tab instead packages without publishing, since the `dry-run` input defaults to true.

A Marketplace version can never be reused, so a tag that fails after the publish step cannot simply be re-tagged. The publish step passes `--skip-duplicate` for that reason: re-running the job is safe.

### Marketplace authentication

Publishing authenticates as a Microsoft Entra ID workload identity federated to this repository, so nothing is stored that needs rotating. This replaced a `VSCE_PAT` secret — Azure DevOps retires the global personal access tokens that Marketplace publishing required on 2026-12-01.

The setup below is one-time, and most of it happens outside this repository.

1. **Create a user-assigned managed identity** in the Azure portal, for example `vscode-publisher`. It has to be a managed identity. An app registration authenticates successfully and then fails at publish with `InvalidAccessException: The requested operation is not allowed`.
2. **Add a federated credential** to it, under Settings → Federated credentials. Choose the "GitHub Actions deploying Azure resources" scenario, name this organization and repository, and set entity type to **Environment** with the name `marketplace-publish`. Scoping to a tag instead would match only the single tag it names, and break on the next release.
3. **Create the `marketplace-publish` environment** under the repository's Settings → Environments, using that same name. Add required reviewers here if a release should pause for approval.
4. **Store the identity's Client ID and Tenant ID** as the `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` repository secrets. Both are on the identity's Properties page. Neither is a credential on its own; the federated credential is what grants access, and it only trusts tokens minted for this repository and environment.
5. **Look up the Azure DevOps profile id** by running the **Marketplace identity** workflow from the Actions tab, and take the `id` field from its output. The Marketplace keeps an identity record separate from the Entra object id and the Azure resource id, and only that record is accepted in the next step.
6. **Add the identity to the publisher** at <https://marketplace.visualstudio.com/manage>, under Members, pasting the id from step 5 and assigning the Contributor role. The other identifiers are not recognized here, so a search that returns nothing usually means the wrong one was pasted.

If publishing reports `You need to be logged in with your corporate credentials`, the publisher and the identity belong to different kinds of account — an Entra tenant identity cannot publish to a personally owned publisher. The publisher has to be owned by the same tenant.

## The icon

`npm run icon` rasterizes `images/logo.svg` to a 256×256 `images/icon.png` using `@resvg/resvg-js`. `images/logo.svg` is a verbatim copy of the Tetrate mark at <https://docs.tetrate.ai/img/logo.svg>. The mark is portrait, so the script reads its `viewBox`, scales it to fit a square canvas with a margin, and centers it. To pick up an upstream logo change, replace that file and re-run the script.
