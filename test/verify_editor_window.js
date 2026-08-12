/* Electron integration test for the separate editor BrowserWindow contract. */
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'test', 'editor-window-fixture.txt');
const secondFixture = path.join(root, 'test', 'editor-window-second.txt');
const savedFixture = path.join(root, 'test', 'editor-window-saved.txt');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(app, marker) {
  for (let i = 0; i < 80; i += 1) {
    const page = app.windows().find((candidate) => candidate.url().includes(marker));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`Window not found: ${marker}`);
}

(async () => {
  fs.writeFileSync(fixture, 'real disk content: first\n');
  fs.writeFileSync(secondFixture, 'real disk content: second\n');
  try {
    const app = await electron.launch({ args: [root], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const main = await waitForWindow(app, 'index.html');
    await main.waitForSelector('.terminal-pane');
    if (await main.locator('#btn-view-terminals, #btn-view-split, #btn-view-editor').count()) throw new Error('legacy view-mode button remains');
    console.log('PASS main toolbar has no Terminals/Split/Editor toggle');

    await main.evaluate((folder) => window.appInstance.fileExplorer.setRootDirectory(folder, true), path.dirname(fixture));
    await main.locator(`.tree-label[title="${fixture}"]`).click();
    const editor = await waitForWindow(app, 'editor.html');
    await editor.waitForSelector('.monaco-editor');
    if (app.windows().length !== 2) throw new Error(`expected 2 windows after first file, got ${app.windows().length}`);
    await editor.waitForFunction((filePath) => {
      const tab = window.editorApp.manager.openTabs.get(filePath);
      return Boolean(tab && tab.model && tab.model.getValue().includes('real disk content: first'));
    }, fixture);
    console.log('PASS first file opened in separate editor window (count 2) with real content');

    await main.locator(`.tree-label[title="${secondFixture}"]`).click();
    await editor.waitForFunction(() => window.editorApp.manager.openTabs.size === 2);
    if (app.windows().length !== 2) throw new Error(`expected 2 windows after second file, got ${app.windows().length}`);
    console.log('PASS second file added as an editor tab (count remains 2)');

    await main.evaluate(async () => {
      await window.appInstance.createPane({ id: 'editor-window-extra-1', agentId: 'shell' });
      await window.appInstance.createPane({ id: 'editor-window-extra-2', agentId: 'shell' });
      window.electronAPI.writePty('pane-1', 'sleep 999\r');
    });
    const saveResult = await editor.evaluate(async () => {
      const path = window.editorApp.manager.activeFilePath;
      window.editorApp.manager.toggleMode(path);
      window.editorApp.manager.editor.setValue('saved from separate editor\n');
      await window.editorApp.save();
      return { path, mode: window.editorApp.manager.openTabs.get(path).mode, value: window.editorApp.manager.editor.getValue() };
    });
    if (fs.readFileSync(secondFixture, 'utf8') !== 'saved from separate editor\n') throw new Error(`Save did not write through IPC: ${JSON.stringify(saveResult)}`);
    await editor.evaluate(async (target) => { await window.electronAPI.setTestSaveAsPath(target); await window.editorApp.saveAs(); }, savedFixture);
    if (!fs.existsSync(savedFixture)) throw new Error('Save As did not write target');
    await editor.evaluate(async (folder) => { await window.electronAPI.setTestDirectoryPath(folder); await window.editorApp.openFolder(); }, root);
    if (await editor.locator('#editor-root-label').textContent() !== root) throw new Error('Open Folder did not update editor context');
    await editor.evaluate(() => window.editorApp.manager.toggleMode(window.editorApp.manager.activeFilePath));
    fs.writeFileSync(savedFixture, 'external refresh confirmed\n');
    await editor.waitForFunction(() => window.editorApp.manager.openTabs.get(window.editorApp.manager.activeFilePath)?.model.getValue().includes('external refresh confirmed'), null, { timeout: 5000 });
    console.log('PASS editor Save, Save As, Open Folder, and external auto-refresh');

    await editor.close();
    await sleep(300);
    if (app.windows().length !== 1) throw new Error(`expected 1 window after editor close, got ${app.windows().length}`);
    const liveness = await main.evaluate(() => {
      const pane = window.appInstance.panes.get('pane-1');
      return { count: window.appInstance.panes.size, status: pane && pane.status };
    });
    if (liveness.count !== 6 || liveness.status !== 'running') throw new Error(`terminal panes changed after editor close: ${JSON.stringify(liveness)}`);
    console.log('PASS editor close leaves all 6 terminal panes running (count 1)');
    await app.close();
  } finally {
    [fixture, secondFixture, savedFixture].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  }
})().catch((err) => { console.error('FAIL', err.stack || err); process.exitCode = 1; });
