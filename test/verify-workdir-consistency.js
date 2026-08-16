/* End-to-end coverage for Open Folder -> file tree, new PTY, and root changes. */
const { _electron: electron } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBuffer(page, paneId, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = await page.evaluate(({ paneId, expected }) => {
      const terminal = window.appInstance.panes.get(paneId)?.terminal;
      let output = '';
      for (let row = 0; terminal && row < terminal.buffer.active.length; row += 1) {
        output += terminal.buffer.active.getLine(row)?.translateToString(true) || '';
      }
      // xterm wraps long absolute paths across buffer rows; joining rows
      // preserves the terminal's actual output for this assertion.
      if (output.includes(expected)) return true;
      return false;
    }, { paneId, expected });
    if (found) return;
    await sleep(100);
  }
  throw new Error(`Terminal ${paneId} did not contain ${expected}`);
}

async function command(page, paneId, text, expected) {
  await page.evaluate(({ paneId, text }) => window.electronAPI.writePty(paneId, `${text}\r`), { paneId, text });
  await waitForBuffer(page, paneId, expected);
  await sleep(150); // allow the shell to redraw its prompt before the next command
}

(async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ide-workdir-'));
  const projectA = path.join(parent, 'test-project');
  const projectB = path.join(parent, 'different-project');
  const runId = path.basename(parent).replace(/[^A-Za-z0-9_-]/g, '');
  const paneA = `root-a-${runId}`;
  const paneB = `root-b-${runId}`;
  fs.mkdirSync(projectA); fs.mkdirSync(projectB);
  fs.writeFileSync(path.join(projectA, 'hello.txt'), 'known hello content\n');
  fs.writeFileSync(path.join(projectB, 'second.txt'), 'second project\n');
  const app = await electron.launch({ args: [appRoot], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');

    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), projectA);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('hello.txt', { exact: true }).waitFor();
    console.log(`PASS file tree shows hello.txt from ${projectA}`);

    await page.evaluate((paneId) => window.appInstance.createPane({ id: paneId, label: 'Root A', agentId: 'shell' }), paneA);
    await command(page, paneA, 'pwd', projectA);
    console.log(`PWD A: ${projectA}`);
    await command(page, paneA, 'cat hello.txt', 'known hello content');
    console.log('CAT A: known hello content');

    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), projectB);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('second.txt', { exact: true }).waitFor();
    await page.evaluate((paneId) => window.appInstance.createPane({ id: paneId, label: 'Root B', agentId: 'shell' }), paneB);
    await command(page, paneB, 'pwd', projectB);
    console.log(`PWD B: ${projectB}`);
    await command(page, paneA, 'pwd', projectA);
    console.log(`PWD existing A after switch: ${projectA}`);
    // Keep within the app's six-pane limit before adding the dedicated
    // stale-session Run Agent probe below.
    await page.evaluate((paneId) => window.appInstance.removePane(paneId), paneA);

    // Shell 1 existed before Open Folder. Run Agent must restart it in the
    // current project rather than type its command into the old startup cwd.
    await page.evaluate(() => {
      window.appInstance.agentsList = [{ id: 'cwd-probe', name: 'Cwd probe', command: 'pwd', env: {} }];
      return window.appInstance.executeAgent({ targetPaneId: 'pane-1', agentId: 'cwd-probe', scope: 'single' });
    });
    await waitForBuffer(page, 'pane-1', projectB);
    console.log(`RUN AGENT SHELL 1 CWD: ${projectB}`);

    // Reproduce the former Run Agent failure: a fixed pane ID had an old tmux
    // session whose cwd differed from the newly opened project. The app must
    // replace it, then Run Agent's write-to-pane path must inherit projectB.
    const runAgentPane = `run-agent-${runId}`;
    const staleSession = `ide-${runAgentPane}`;
    execFileSync('tmux', ['new-session', '-d', '-s', staleSession, '-c', projectA]);
    await page.evaluate((paneId) => window.appInstance.createPane({ id: paneId, label: 'Run Agent', agentId: 'shell' }), runAgentPane);
    await command(page, runAgentPane, 'pwd', projectB);
    console.log(`RUN AGENT PANE CWD BEFORE COMMAND: ${projectB}`);
    await page.evaluate((paneId) => window.appInstance.executeAgent({ targetPaneId: paneId, agentId: 'cwd-probe', scope: 'single' }), runAgentPane);
    await waitForBuffer(page, runAgentPane, projectB);
    console.log(`RUN AGENT COMMAND CWD: ${projectB}`);

    // The Explorer should update from a root-directory fs.watch notification,
    // without reopening the folder or explicitly calling render().
    const created = path.join(projectB, 'StarPattern.java');
    fs.writeFileSync(created, 'class StarPattern {}\n');
    await page.getByText('StarPattern.java', { exact: true }).waitFor();
    console.log('EXPLORER AUTO-REFRESH: StarPattern.java appeared');
    try { execFileSync('tmux', ['kill-session', '-t', staleSession]); } catch (_) {}
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(parent, { recursive: true, force: true });
  }
})().catch((error) => { console.error('FAIL workdir consistency suite:', error.stack || error); process.exitCode = 1; });
