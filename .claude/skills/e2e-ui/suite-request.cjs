/**
 * Runs inside the VS Code extension host. Stands up a local OpenAI-compatible
 * endpoint, points the extension at it, stores a key, and sends a real chat
 * request through vscode.lm so every UI surface reacts to genuine traffic.
 */
const cp = require('child_process');
const http = require('http');
const fs = require('fs');
const vscode = require('vscode');

fs.mkdirSync('/tmp/tars-e2e', { recursive: true });

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function shot(name) {
    try {
        cp.execSync(`screencapture -x /tmp/tars-e2e/${name}.png`);
    } catch {
        console.log(`  (screenshot ${name} unavailable)`);
    }
}

const REPLY = ['Hello', ' from', ' the', ' Agent', ' Router', ' test.'];

function startMockRouter() {
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    object: 'list',
                    data: [{ id: 'claude-e2e-model', object: 'model' }],
                })
            );
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
            });
            const chunk = (payload) =>
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            const base = {
                id: 'chatcmpl-e2e',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-e2e-model',
            };
            let i = 0;
            chunk({
                ...base,
                choices: [
                    { index: 0, delta: { role: 'assistant' }, finish_reason: null },
                ],
            });
            // Slow enough that the status bar spinner is visible on a
            // screenshot taken mid-stream.
            const timer = setInterval(() => {
                if (i < REPLY.length) {
                    chunk({
                        ...base,
                        choices: [
                            {
                                index: 0,
                                delta: { content: REPLY[i] },
                                finish_reason: null,
                            },
                        ],
                    });
                    i += 1;
                    return;
                }
                clearInterval(timer);
                chunk({
                    ...base,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                });
                chunk({
                    ...base,
                    choices: [],
                    usage: {
                        prompt_tokens: 1200,
                        completion_tokens: 34,
                        total_tokens: 1234,
                        prompt_tokens_details: { cached_tokens: 200 },
                        completion_tokens_details: { reasoning_tokens: 0 },
                    },
                });
                res.write('data: [DONE]\n\n');
                res.end();
            }, 400);
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(server))
    );
}

exports.run = async () => {
    const server = await startMockRouter();
    const port = server.address().port;
    console.log(`  mock Agent Router listening on 127.0.0.1:${port}`);

    const ext = vscode.extensions.getExtension('tetrate.tetrate-model-provider');
    await ext.activate();
    check('extension activates', ext.isActive);

    await vscode.workspace
        .getConfiguration('tetrate-model-provider')
        .update(
            'baseUrl',
            `http://127.0.0.1:${port}/v1`,
            vscode.ConfigurationTarget.Global
        );

    // The key lives in secret storage behind an input box; the test module
    // shares the dev extension's API instance, so patching the input box
    // feeds the command a key without a human at the keyboard.
    const originalInput = vscode.window.showInputBox;
    const originalInfo = vscode.window.showInformationMessage;
    vscode.window.showInputBox = async () => 'sk-e2e-test-key';
    vscode.window.showInformationMessage = async () => undefined;
    try {
        await Promise.race([
            vscode.commands.executeCommand('tetrate-model-provider.setApiKey'),
            sleep(3000),
        ]);
    } finally {
        vscode.window.showInputBox = originalInput;
        vscode.window.showInformationMessage = originalInfo;
    }

    // Discovery against the mock: proves the key was stored and /models read.
    let models = [];
    for (let attempt = 0; attempt < 10 && models.length === 0; attempt++) {
        models = await vscode.lm.selectChatModels({
            vendor: 'tetrate-agent-router',
        });
        if (models.length === 0) {
            await sleep(500);
        }
    }
    check(
        'model discovered over the wire',
        models.length === 1 && models[0].id === 'claude-e2e-model',
        models.map((m) => m.id).join(',') || 'none'
    );
    if (models.length === 0) {
        server.close();
        throw new Error('no models; key injection or discovery failed');
    }

    // Open the tree and requests view so the request's effects are on screen.
    await vscode.commands.executeCommand(
        'workbench.view.extension.tetrate-agent-router'
    );

    // The real request, through the same lm API any consuming extension uses.
    const request = models[0].sendRequest(
        [vscode.LanguageModelChatMessage.User('Say hello.')],
        { justification: 'E2E test of the usage UI.' },
        new vscode.CancellationTokenSource().token
    );
    const response = await Promise.race([
        request,
        sleep(15000).then(() => {
            throw new Error(
                'sendRequest did not start within 15s (consent dialog?)'
            );
        }),
    ]);

    // Mid-stream: the status bar should be showing the spinner right now.
    await sleep(1200);
    shot('5-streaming');

    let text = '';
    for await (const part of response.text) {
        text += part;
    }
    check('streamed text arrives intact', text === REPLY.join(''), text);

    // Give the usage event a beat to fan out to bar, tree, log, dashboard.
    await sleep(1500);
    shot('6-after-request');

    await vscode.commands.executeCommand('tetrate-model-provider.requests.focus');
    await sleep(800);
    shot('7-requests-view');

    await vscode.commands.executeCommand('tetrate-model-provider.showUsage');
    await sleep(1500);
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    check(
        'dashboard tab open after request',
        tabs.some((tab) => tab.label === 'Agent Router Usage')
    );
    shot('8-dashboard-live');

    server.close();
    const failed = results.filter((r) => !r.ok);
    console.log(
        `E2E summary: ${results.length - failed.length}/${results.length} checks passed`
    );
    if (failed.length > 0) {
        throw new Error(`failing checks: ${failed.map((f) => f.name).join(', ')}`);
    }
};
