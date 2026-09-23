---
name: e2e-ui
description: Launch a real VS Code window with the dev extension loaded and drive its UI end to end — tree views, dashboard webview, status bar, command menu, and a real streamed chat request against a local mock router — with screenshots as evidence. Use when asked to run, test, or screenshot the extension UI in VS Code.
---

# E2E UI testing in a real VS Code window

Verified on macOS with the installed VS Code app. Two suites live next to
this file: `suite-smoke.cjs` (no API key needed; verifies commands, views,
webview, quick pick) and `suite-request.cjs` (sends a real streamed request
through `vscode.lm` against a local mock router; verifies the spinner,
usage recording, Recent Requests row, badge, and live dashboard).

## Setup (once per run)

```bash
cd <repo root>
npm run bundle                      # dev bundle; the request suite's key
                                    # injection needs it NON-minified
npm i --no-save @vscode/test-electron
mkdir -p /tmp/tars-e2e
```

## Smoke suite (no key)

```bash
node .claude/skills/e2e-ui/runner.cjs suite-smoke.cjs
```

A VS Code window opens on an isolated profile (fresh user-data and
extensions dirs under mkdtemp), runs the checks inside the extension host,
prints PASS/FAIL lines, and exits. Screenshots land in `/tmp/tars-e2e/`.

## Real-request suite

The extension only lists models when a key is stored, and secret storage
cannot be written from outside the extension. The trick that works: run a
TEMPORARY COPY of the extension whose bundle gets an env-var fallback
injected, and pass the key through the test environment.

```bash
rm -rf /tmp/tars-ext && mkdir -p /tmp/tars-ext
cp -R package.json images media out /tmp/tars-ext/
sed -i '' 's|async function getApiKey(context, baseUrl) {|async function getApiKey(context, baseUrl) { if (process.env.TARS_E2E_KEY) return process.env.TARS_E2E_KEY;|' /tmp/tars-ext/out/extension.js
grep -c TARS_E2E_KEY /tmp/tars-ext/out/extension.js   # must print 1

TARS_E2E_KEY=sk-e2e-test-key EXT_DEV_PATH=/tmp/tars-ext \
    node .claude/skills/e2e-ui/runner.cjs suite-request.cjs
```

The suite starts an OpenAI-compatible mock router on 127.0.0.1 (SSE
streaming with a usage block carrying cached and reasoning token details),
points `baseUrl` at it via the configuration API, discovers the mock model
over the wire, and sends a request through `vscode.lm.sendRequest`. The
repo itself is never modified.

## Read the screenshots

`/tmp/tars-e2e/*.png` — always LOOK at them (Read tool); the assertions
prove the plumbing, the screenshots prove the pixels. Mid-stream shots
show the status bar spinner; post-request shots show the cost/token
headline, the activity bar badge, the Recent Requests row, and the
dashboard tables.

## Cleanup

```bash
npm prune                 # removes the --no-save test dependency
rm -rf /tmp/tars-ext
```

## Gotchas (each cost a debugging round)

- The macOS binary is `/Applications/Visual Studio Code.app/Contents/MacOS/Code`,
  not `.../Electron` — ENOENT otherwise.
- `--user-data-dir` and `--extensions-dir` MUST be passed, or the launch is
  forwarded to the already-running VS Code instance and exits immediately.
- Monkey-patching `vscode.window.showInputBox` from the test suite does NOT
  reach the extension: each extension gets its own API instance, and the
  test module's patch never crosses. That is why the env-fallback copy
  exists — do not retry the patch route.
- Do not await commands that show toasts with buttons (`setApiKey`): the
  promise resolves only when the toast is dismissed. Fire and sleep.
- Machine-scoped settings (`baseUrl`) ARE writable programmatically with
  `ConfigurationTarget.Global`.
- The mock model is absent from the public catalog, so the status bar shows
  the `1,234 tokens` fallback headline and cost reads `unknown`/`unpriced`.
  That is correct behaviour, not a failure.
- The chat participant renders its turn in a clean profile, but the chat
  pipeline answers "Language model unavailable" without a configured chat
  model; assert registration, not response content.
- Screenshots are whole-screen `screencapture -x`; the test window is
  frontmost so this suffices. A blank frame means the window never opened.
