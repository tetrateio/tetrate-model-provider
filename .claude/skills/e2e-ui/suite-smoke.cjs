/** Runs inside the VS Code extension host; drives the extension's UI. */
const cp = require('child_process');
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

exports.run = async () => {
    const ext = vscode.extensions.getExtension('tetrate.tetrate-model-provider');
    check('extension is loaded', Boolean(ext));
    await ext.activate();
    check('extension activates', ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
        'menu', 'showUsage', 'testConnection', 'addProfile', 'removeProfile',
        'useInChat', 'chooseModels', 'switchEndpoint', 'refreshModelsView',
        'openDashboard',
    ]) {
        check(
            `command ${id} is registered`,
            commands.includes(`tetrate-model-provider.${id}`)
        );
    }

    // The activity bar container and both views. focus commands are generated
    // per registered view, so succeeding proves the views exist.
    await vscode.commands.executeCommand(
        'workbench.view.extension.tetrate-agent-router'
    );
    check('activity bar container opens', true);
    await vscode.commands.executeCommand('tetrate-model-provider.overview.focus');
    check('Overview view focuses', true);
    await vscode.commands.executeCommand('tetrate-model-provider.requests.focus');
    check('Recent Requests view focuses', true);
    await vscode.commands.executeCommand('tetrate-model-provider.overview.focus');
    await sleep(1200);
    shot('1-overview');

    // The dashboard webview: opening must create a tab with our title.
    await vscode.commands.executeCommand('tetrate-model-provider.showUsage');
    await sleep(1200);
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const dashboard = tabs.find((tab) => tab.label === 'Agent Router Usage');
    check(
        'usage dashboard opens as a webview tab',
        Boolean(dashboard) && dashboard.input instanceof vscode.TabInputWebview
    );
    shot('2-dashboard');

    // The command menu quick pick: open it, screenshot, dismiss it. The
    // command resolves only after the pick settles, so it is not awaited
    // until the dismissal has gone through.
    const menu = vscode.commands.executeCommand('tetrate-model-provider.menu');
    await sleep(900);
    shot('3-command-menu');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await menu;
    check('command menu opens and dismisses', true);

    // The chat participant: best-effort, the clean profile may lack chat.
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: '@tetrate /usage',
        });
        await sleep(1200);
        shot('4-chat');
        check('chat view opens with @tetrate query', true);
    } catch (error) {
        check('chat view opens with @tetrate query', false, String(error));
    }

    const failed = results.filter((r) => !r.ok);
    console.log(
        `E2E summary: ${results.length - failed.length}/${results.length} checks passed`
    );
    if (failed.length > 0) {
        throw new Error(`failing checks: ${failed.map((f) => f.name).join(', ')}`);
    }
};
