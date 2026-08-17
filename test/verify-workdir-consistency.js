/* End-to-end coverage for Open Folder -> file tree, new PTY, and root changes. */
const { _electron: electron } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for command output file: ${filePath}`);
}

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
  const output = await page.evaluate((id) => {
    const terminal = window.appInstance.panes.get(id)?.terminal;
    return Array.from({ length: terminal?.buffer.active.length || 0 }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) || '').join('\n');
  }, paneId);
  throw new Error(`Terminal ${paneId} did not contain ${expected}; buffer=${JSON.stringify(output.slice(-1500))}`);
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
  const physicalProjectA = fs.realpathSync(projectA);
  const physicalProjectB = fs.realpathSync(projectB);
  fs.mkdirSync(path.join(projectA, 'nested', 'level-two'), { recursive: true });
  fs.writeFileSync(path.join(projectA, 'hello.txt'), 'known hello content\n');
  fs.writeFileSync(path.join(projectA, 'nested', 'level-two', 'deep.txt'), 'deep content\n');
  fs.writeFileSync(path.join(projectB, 'second.txt'), 'second project\n');
  const app = await electron.launch({ args: [appRoot], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    page.on('console', (message) => {
      if (message.text().includes('[FileExplorer]')) console.log(`EXPLORER LOG: ${message.text()}`);
    });

    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), projectA);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('hello.txt', { exact: true }).waitFor();
    console.log(`PASS file tree shows hello.txt from ${projectA}`);

    // The opened root itself must be a real toggle node, not a static label.
    await page.locator('.file-tree-root-header').click();
    await page.getByText('hello.txt', { exact: true }).waitFor({ state: 'hidden' });
    console.log('ROOT COLLAPSE: immediate children hidden');
    await page.locator('.file-tree-root-header').click();
    await page.getByText('hello.txt', { exact: true }).waitFor();
    console.log('ROOT EXPAND: immediate children shown via fs:read-dir IPC');
    await page.getByText('nested', { exact: true }).click();
    await page.getByText('level-two', { exact: true }).waitFor();
    await page.getByText('level-two', { exact: true }).click();
    await page.getByText('deep.txt', { exact: true }).waitFor();
    console.log('NESTED EXPAND: nested/level-two/deep.txt shown');

    await page.evaluate((paneId) => window.appInstance.createPane({ id: paneId, label: 'Root A', agentId: 'shell' }), paneA);
    await command(page, paneA, 'pwd -P', physicalProjectA);
    console.log(`PWD -P A: ${physicalProjectA}`);
    await command(page, paneA, 'ls -1 hello.txt', 'hello.txt');
    console.log('LS A: hello.txt');
    await command(page, paneA, 'printf pane-created > pane-created.txt; ls -1 pane-created.txt', 'pane-created.txt');
    await page.locator('#sidebar-file-tree').getByText('pane-created.txt', { exact: true }).waitFor();
    console.log('PANE CREATE: pane-created.txt exists in shell and Explorer auto-refresh');
    // Keep under the six-pane UI ceiling while testing a second fresh pane.
    await page.evaluate((paneId) => window.appInstance.removePane(paneId), paneA);

    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), projectB);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('second.txt', { exact: true }).waitFor();
    const paneBState = await page.evaluate(async (paneId) => {
      await window.appInstance.createPane({ id: paneId, label: 'Root B', agentId: 'shell' });
      return { paneCwd: window.appInstance.panes.get(paneId)?.cwd, projectRoot: await window.electronAPI.getProjectRoot() };
    }, paneB);
    console.log(`NEW PANE B STATE: ${JSON.stringify(paneBState)}`);
    await sleep(1000); // wait for the new shell prompt after the PTY is attached
    await command(page, paneB, `test "$(pwd -P)" = '${physicalProjectB}' && echo CWD_EXACT_PASS`, 'CWD_EXACT_PASS');
    console.log(`PWD -P B exact match: ${physicalProjectB}`);

    // Shell 1 existed before Open Folder. Run Agent must restart it in the
    // current project rather than type its command into the old startup cwd.
    await page.evaluate(() => {
      window.appInstance.agentsList = [{ id: 'cwd-probe', name: 'Cwd probe', command: 'pwd -P > .run-agent-cwd; echo RUN_AGENT_CWD_EXACT', env: {} }];
      return window.appInstance.executeAgent({ targetPaneId: 'pane-1', agentId: 'cwd-probe', scope: 'single' });
    });
    await waitForFile(path.join(physicalProjectB, '.run-agent-cwd'));
    if (fs.readFileSync(path.join(physicalProjectB, '.run-agent-cwd'), 'utf8').trim() !== physicalProjectB) throw new Error('Run Agent default pane cwd mismatch');
    console.log(`RUN AGENT SHELL 1 PWD -P: ${physicalProjectB}`);

    // Reproduce the former Run Agent failure: a fixed pane ID had an old tmux
    // session whose cwd differed from the newly opened project. The app must
    // replace it, then Run Agent's write-to-pane path must inherit projectB.
    const runAgentPane = `run-agent-${runId}`;
    const staleSession = `ide-${runAgentPane}`;
    execFileSync('tmux', ['new-session', '-d', '-s', staleSession, '-c', projectA]);
    await page.evaluate((paneId) => window.appInstance.createPane({ id: paneId, label: 'Run Agent', agentId: 'shell' }), runAgentPane);
    await command(page, runAgentPane, `test "$(pwd -P)" = '${physicalProjectB}' && echo CWD_EXACT_PASS`, 'CWD_EXACT_PASS');
    console.log(`RUN AGENT PANE PWD -P BEFORE COMMAND: ${physicalProjectB}`);
    fs.unlinkSync(path.join(physicalProjectB, '.run-agent-cwd'));
    await page.evaluate((paneId) => window.appInstance.executeAgent({ targetPaneId: paneId, agentId: 'cwd-probe', scope: 'single' }), runAgentPane);
    await waitForFile(path.join(physicalProjectB, '.run-agent-cwd'));
    if (fs.readFileSync(path.join(physicalProjectB, '.run-agent-cwd'), 'utf8').trim() !== physicalProjectB) throw new Error('Run Agent command cwd mismatch');
    console.log(`RUN AGENT COMMAND PWD -P: ${physicalProjectB}`);

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
