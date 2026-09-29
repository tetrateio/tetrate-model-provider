/**
 * Runs inside the VS Code extension host. Stands up a mock gateway serving
 * both protocols, enables passthrough, and sends one Claude request and one
 * non-Claude request through vscode.lm. The mock records which route and
 * which headers each request used, so the suite proves the routing split and
 * that each credential travels in its own header.
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

const TARS_KEY = process.env.TARS_E2E_KEY;
const ANTHROPIC_KEY = process.env.TARS_E2E_ANTHROPIC_KEY;
const seen = [];

function startMockGateway() {
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, headers: req.headers });
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        { id: 'claude-e2e-model', owned_by: 'anthropic' },
                        { id: 'gpt-e2e-model', owned_by: 'openai' },
                    ],
                })
            );
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/messages') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const event = (type, data) =>
                res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            event('message_start', {
                message: {
                    id: 'msg_e2e', type: 'message', role: 'assistant',
                    model: 'claude-e2e-model', content: [], stop_reason: null,
                    usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 1 },
                },
            });
            event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
            for (const text of ['Hello', ' via', ' passthrough.']) {
                event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
            }
            event('content_block_stop', { index: 0 });
            event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
            event('message_stop', {});
            res.end();
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'gpt-e2e-model' };
            const chunk = (payload) => res.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`);
            chunk({ choices: [{ index: 0, delta: { content: 'Hello managed.' }, finish_reason: null }] });
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function ask(model) {
    const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User('Say hello.')],
        { justification: 'E2E test of passthrough.' },
        new vscode.CancellationTokenSource().token
    );
    let text = '';
    for await (const part of response.text) {
        text += part;
    }
    return text;
}

exports.run = async () => {
    const server = await startMockGateway();
    const port = server.address().port;
    console.log(`  mock gateway listening on 127.0.0.1:${port}`);

    const ext = vscode.extensions.getExtension('tetrate.tetrate-model-provider');
    await ext.activate();
    check('extension activates', ext.isActive);

    const config = vscode.workspace.getConfiguration('tetrate-model-provider');
    await config.update('baseUrl', `http://127.0.0.1:${port}/v1`, vscode.ConfigurationTarget.Global);
    await config.update('passthrough.enabled', true, vscode.ConfigurationTarget.Global);
    await sleep(500);

    let models = [];
    for (let attempt = 0; attempt < 10 && models.length < 2; attempt++) {
        models = await vscode.lm.selectChatModels({ vendor: 'tetrate-agent-router' });
        if (models.length < 2) {
            await sleep(500);
        }
    }
    const claude = models.find((m) => m.id === 'claude-e2e-model');
    const gpt = models.find((m) => m.id === 'gpt-e2e-model');
    check('both models discovered', Boolean(claude && gpt), models.map((m) => m.id).join(','));
    if (!claude || !gpt) {
        server.close();
        throw new Error('discovery failed');
    }

    check('Claude streams through passthrough', (await ask(claude)) === 'Hello via passthrough.');
    const messages = seen.find((r) => r.url === '/v1/messages');
    check('Claude request used /v1/messages', Boolean(messages));
    check('Anthropic key sent as x-api-key', messages?.headers['x-api-key'] === ANTHROPIC_KEY);
    check('Agent Router key sent as x-tars-api-key', messages?.headers['x-tars-api-key'] === TARS_KEY);
    check('no Authorization header on passthrough', messages && messages.headers.authorization === undefined,
        String(messages?.headers.authorization));
    check('request id sent', /^[0-9a-f-]{36}$/.test(messages?.headers['x-request-id'] ?? ''));

    check('non-Claude model streams managed', (await ask(gpt)) === 'Hello managed.');
    const chat = seen.find((r) => r.url === '/v1/chat/completions');
    check('non-Claude request used /v1/chat/completions', Boolean(chat));
    check('managed request carries the Agent Router bearer', chat?.headers.authorization === `Bearer ${TARS_KEY}`);
    check('managed request carries no Anthropic key', chat && chat.headers['x-api-key'] === undefined);

    await sleep(1500);
    await vscode.commands.executeCommand('workbench.view.extension.tetrate-agent-router');
    await vscode.commands.executeCommand('tetrate-model-provider.requests.focus');
    await sleep(1000);
    shot('9-passthrough-requests');
    await vscode.commands.executeCommand('tetrate-model-provider.showUsage');
    await sleep(1500);
    shot('10-passthrough-dashboard');

    await config.update('passthrough.enabled', undefined, vscode.ConfigurationTarget.Global);
    server.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`E2E summary: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
        throw new Error(`failing checks: ${failed.map((f) => f.name).join(', ')}`);
    }
};
