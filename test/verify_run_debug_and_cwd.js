/* Integration test for Editor Run/Debug and Agent Folder Targeting */
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const sandboxDir = path.join(root, 'test', 'test-sandbox');
const testJsFile = path.join(sandboxDir, 'demo_script.js');
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
  console.log('=== STARTING INTEGRATION VERIFICATION ===');

  // Prepare sandbox directory & test script
  if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });

  fs.writeFileSync(
    testJsFile,
    `console.log("RUN_OUTPUT_MARKER_START");\n` +
    `let x = 42;\n` +
    `let y = 100;\n` +
    `console.log("RUN_OUTPUT_MARKER_END", x + y);\n`
  );

  const testMarkerInApp = path.join(root, 'test-marker.txt');
  const testMarkerInSandbox = path.join(sandboxDir, 'test-marker.txt');

  if (fs.existsSync(testMarkerInApp)) fs.unlinkSync(testMarkerInApp);
  if (fs.existsSync(testMarkerInSandbox)) fs.unlinkSync(testMarkerInSandbox);

  let app;
  try {
    app = await electron.launch({
      args: [root],
      env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });

    const main = await waitForWindow(app, 'index.html');
    await main.waitForSelector('.terminal-pane');

    // -------------------------------------------------------------
    // VERIFICATION STEP 1 & 2: Set project root to sandbox & test relative file writes
    // -------------------------------------------------------------
    console.log('Testing Agent folder targeting fix...');
    await main.evaluate(async (folder) => {
      await window.electronAPI.setProjectRoot(folder);
      await window.appInstance.fileExplorer.setRootDirectory(folder, true);
    }, sandboxDir);

    const customModelTools = require('../main/custom-model-tools');
    const executeToolResult = await customModelTools.executeTool('write_file', { path: 'test-marker.txt', content: 'hello from agent tool' }, sandboxDir);
    console.log('Tool execute result:', executeToolResult);

    if (fs.existsSync(testMarkerInApp)) {
      throw new Error(`FAIL: Relative path write landed inside IDE source folder: ${testMarkerInApp}`);
    }

    if (!fs.existsSync(testMarkerInSandbox)) {
      throw new Error(`FAIL: Relative path write did NOT land inside target sandbox directory: ${testMarkerInSandbox}`);
    }

    console.log('PASS: Tool-calling write_file correctly landed inside project root, NOT in app source tree.');

    // -------------------------------------------------------------
    // VERIFICATION STEP 3 & 4: Editor Window Run / Debug test
    // -------------------------------------------------------------
    console.log('Testing Editor window Run & Debug execution...');
    await main.evaluate((filePath) => window.electronAPI.openEditorFile(filePath), testJsFile);

    const editor = await waitForWindow(app, 'editor.html');
    await editor.waitForSelector('.monaco-editor');
    await editor.waitForFunction((file) => {
      const tab = window.editorApp?.manager?.openTabs?.get(file);
      return Boolean(tab && tab.model && window.editorApp.manager.activeFilePath === file);
    }, testJsFile, { timeout: 10000 });

    // Test RUN
    console.log('Testing Run execution...');
    const runRes = await editor.evaluate(async () => {
      return await window.editorApp.executeRun('run');
    });
    console.log('Run res:', runRes);

    await editor.waitForFunction(() => {
      const content = document.getElementById('run-output-content')?.textContent || '';
      return content.includes('RUN_OUTPUT_MARKER_START') && content.includes('RUN_OUTPUT_MARKER_END 142');
    }, null, { timeout: 10000 });

    console.log('PASS: Run execution output streamed live to Run Output panel.');

    // Test DEBUG with Gutter Breakpoint
    console.log('Testing Debug execution with Monaco gutter breakpoint...');

    // Set breakpoint on line 2 (let x = 42)
    await editor.evaluate(() => {
      const activeFile = window.editorApp.manager.activeFilePath;
      window.editorApp.manager.toggleBreakpoint(activeFile, 2);
    });

    const hasBp = await editor.evaluate(() => {
      const activeFile = window.editorApp.manager.activeFilePath;
      return window.editorApp.manager.getBreakpoints(activeFile).includes(2);
    });

    if (!hasBp) throw new Error('FAIL: Breakpoint was not recorded in editor manager.');

    // Trigger Debug
    await editor.evaluate(async () => {
      await window.editorApp.executeRun('debug');
    });

    // Wait for Debug paused event
    await editor.waitForFunction(() => {
      const status = document.getElementById('run-output-status')?.textContent || '';
      return status.includes('Paused on line 2');
    }, null, { timeout: 12000 });

    console.log('PASS: Debug execution launched node --inspect-brk and paused on breakpoint line 2.');

    // Continue execution to completion
    await editor.evaluate(() => {
      window.editorApp.sendDebugCmd('resume');
    });

    await editor.waitForFunction(() => {
      const status = document.getElementById('run-output-status')?.textContent || '';
      return status.includes('Exited with code 0');
    }, null, { timeout: 10000 });

    console.log('PASS: Debug process resumed and exited cleanly with code 0.');

    // -------------------------------------------------------------
    // VERIFICATION STEP 5: Print `ls` listing output of both project folder and app source
    // -------------------------------------------------------------
    console.log('\n=== DIRECTORY LISTING VERIFICATION ===');
    console.log(`Contents of opened project folder (${sandboxDir}):`);
    const sandboxFiles = fs.readdirSync(sandboxDir);
    console.log(sandboxFiles.map(f => `  - ${f}`).join('\n'));

    console.log(`\nContents of app root folder (${root}):`);
    const appFiles = fs.readdirSync(root);
    const leakageCheck = appFiles.filter(f => f === 'test-marker.txt' || f === 'demo_script.js');

    if (leakageCheck.length > 0) {
      throw new Error(`FAIL: Found leaked files in app root: ${leakageCheck.join(', ')}`);
    }

    console.log('PASS: Zero leaked files found in app root folder.');
    console.log('\nALL VERIFICATION TESTS PASSED SUCCESSFULLY!');

    await app.close();
  } catch (err) {
    if (app) await app.close().catch(() => {});
    console.error('\nVERIFICATION TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
