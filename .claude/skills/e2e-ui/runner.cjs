/**
 * Launches the installed VS Code (isolated profile) with the dev extension
 * and runs a suite from this directory inside the extension host.
 *
 *   node runner.cjs suite-smoke.cjs
 *   TARS_E2E_KEY=sk-... EXT_DEV_PATH=/tmp/tars-ext node runner.cjs suite-request.cjs
 *
 * EXT_DEV_PATH defaults to the repo root; the request suite needs the
 * env-key temp copy described in SKILL.md.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..', '..');
const { runTests } = require(
    path.join(REPO, 'node_modules', '@vscode/test-electron')
);

const suite = process.argv[2];
if (!suite) {
    console.error('usage: node runner.cjs <suite file in this directory>');
    process.exit(2);
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-'));
    await runTests({
        vscodeExecutablePath:
            '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
        extensionDevelopmentPath: process.env.EXT_DEV_PATH || REPO,
        extensionTestsPath: path.resolve(__dirname, suite),
        ...(process.env.TARS_E2E_KEY
            ? { extensionTestsEnv: { TARS_E2E_KEY: process.env.TARS_E2E_KEY } }
            : {}),
        launchArgs: [
            // Both dirs are required: without them the launch is forwarded
            // to the running VS Code instance and exits immediately.
            '--user-data-dir', path.join(tmp, 'user'),
            '--extensions-dir', path.join(tmp, 'ext'),
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-telemetry',
            '--new-window',
        ],
    });
    console.log('E2E: all checks passed');
})().catch((error) => {
    console.error('E2E: FAILED —', error && error.message ? error.message : error);
    process.exit(1);
});
