/* Windows-path regression: Run Agent must use the opened folder, including spaces. */
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file, page) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (fs.existsSync(file)) return;
    await sleep(100);
  }
  const terminal = await page.evaluate(() => {
    const buffer = window.appInstance.panes.get('pane-1')?.terminal?.buffer.active;
    return Array.from({ length: buffer?.length || 0 }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n');
  });
  throw new Error(`Timed out waiting for ${file}; terminal=${JSON.stringify(terminal)}`);
}

(async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'External Drive Simulation - '));
  const openedFolder = path.join(parent, 'Agent Terminal IDE spaces [removable]');
  const marker = path.join(openedFolder, 'created-by-run-agent.txt');
  fs.mkdirSync(openedFolder);
  const expected = fs.realpathSync(openedFolder);
  const app = await electron.launch({ args: [appRoot], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    const observed = await page.evaluate(async ({ openedFolder }) => {
      await window.electronAPI.setProjectRoot(openedFolder);
      window.appInstance.agentsList = [{
        id: 'cwd-file-probe', name: 'Cwd file probe',
        command: "node -e \"require('fs').writeFileSync('created-by-run-agent.txt', process.cwd())\"", env: {}
      }];
      await window.appInstance.executeAgent({ targetPaneId: 'pane-1', agentId: 'cwd-file-probe', scope: 'single' });
      const pane = window.appInstance.panes.get('pane-1');
      return { projectRoot: await window.electronAPI.getProjectRoot(), paneCwd: pane.cwd, headerCwd: pane.cwdText.textContent, headerTitle: pane.cwdText.title };
    }, { openedFolder });
    await waitForFile(marker, page);
    const createdAt = fs.readFileSync(marker, 'utf8').trim();
    if (createdAt !== expected) throw new Error(`Run Agent wrote from ${createdAt}, expected ${expected}`);
    if (observed.projectRoot !== expected || observed.paneCwd !== expected || observed.headerCwd !== expected || observed.headerTitle !== expected) {
      throw new Error(`Incorrect resolved/header cwd: ${JSON.stringify(observed)}`);
    }
    console.log(`RESOLVED CWD AT SPAWN: ${expected}`);
    console.log(`RUN AGENT CREATED: ${marker}`);
    console.log(`DIRECTORY LISTING: ${fs.readdirSync(openedFolder).join(', ')}`);
    console.log(`PANE HEADER CWD: ${observed.headerCwd}`);
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(parent, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
