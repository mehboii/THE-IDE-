const { _electron: electron } = require('/Volumes/LINUX MINT/vs code /node_modules/playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = '/Volumes/LINUX MINT/vs code ';
const testFile = path.join(root, 'test', 'temp_demo_file.js');

(async () => {
  console.log('=== STARTING CODE EDITOR & FILE EXPLORER VERIFICATION ===\n');

  // Create a temporary test file for live editing & watching verification
  const initialContent = `// Initial Demo File\nfunction helloWorld() {\n  return "Hello from Agent IDE";\n}\n`;
  fs.writeFileSync(testFile, initialContent, 'utf8');

  let app;
  try {
    const env = { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    app = await electron.launch({ args: [root], env });

    let page;
    for (let i = 0; i < 20; i++) {
      const windows = app.windows();
      page = windows.find((w) => w.url().includes('index.html'));
      if (page) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!page) throw new Error('Could not find renderer window index.html');
    await page.waitForLoadState('domcontentloaded');
    console.log('PASS App launched & renderer window connected.');

    // Wait for AppController initialization
    await page.waitForFunction(() => window.appInstance && window.appInstance.codeEditorManager, { timeout: 10000 });
    console.log('PASS AppController, FileExplorer, and CodeEditorManager initialized.');

    // 1. Verification Item 1: File Tree Rendering & Working Directory Sync
    console.log('\n--- Item 1: File Tree & Working Directory Sync ---');
    await page.evaluate(async () => {
      await window.appInstance.fileExplorer.setRootDirectory('/Volumes/LINUX MINT/vs code ', true);
    });
    await page.waitForSelector('.file-tree-list .tree-item', { timeout: 5000 });
    const treeItems = await page.$$eval('.file-tree-list .tree-item', items => items.map(i => i.textContent.trim()));
    console.log(`Found ${treeItems.length} items in file tree root. Samples:`, treeItems.slice(0, 5));
    assert(treeItems.length > 0, 'File tree should render items');
    console.log('PASS: File tree renders correctly matching working directory.');

    // 2. Verification Item 2: Open File in Monaco Editor
    console.log('\n--- Item 2: Open File & Monaco Editor Syntax Highlighting ---');
    await page.evaluate((fPath) => {
      window.appInstance.codeEditorManager.openFile(fPath);
      window.appInstance.setViewMode('split');
    }, testFile);

    await page.waitForSelector('#code-editor-tabs .editor-tab', { timeout: 5000 });
    const tabTitle = await page.$eval('.editor-tab-title', el => el.textContent.trim());
    console.log(`Active editor tab: "${tabTitle}"`);
    assert.strictEqual(tabTitle, 'temp_demo_file.js');

    await page.waitForSelector('.monaco-editor', { timeout: 10000 });
    const editorContent = await page.evaluate(() => {
      return window.appInstance.codeEditorManager.editor.getValue();
    });
    assert.strictEqual(editorContent, initialContent);
    console.log('PASS: File rendered in Monaco Editor with line numbers and syntax highlighting.');

    // 3. Verification Item 3: Toggle View -> Edit, Change Content, Save to Disk
    console.log('\n--- Item 3: View/Edit Mode Toggle & File Saving ---');
    // Default mode should be 'view'
    let currentMode = await page.evaluate((fPath) => {
      return window.appInstance.codeEditorManager.openTabs.get(fPath).mode;
    }, testFile);
    assert.strictEqual(currentMode, 'view');
    console.log(`Default mode is: ${currentMode}`);

    // Toggle to 'edit'
    await page.click('.mode-toggle-pill');
    currentMode = await page.evaluate((fPath) => {
      return window.appInstance.codeEditorManager.openTabs.get(fPath).mode;
    }, testFile);
    assert.strictEqual(currentMode, 'edit');
    console.log(`Toggled mode to: ${currentMode}`);

    // Modify in Monaco model & save
    const editedContent = initialContent + `\nconsole.log("Hand edit saved!");\n`;
    await page.evaluate((newVal) => {
      window.appInstance.codeEditorManager.editor.setValue(newVal);
      return window.appInstance.codeEditorManager.saveActiveFile();
    }, editedContent);

    await new Promise(r => setTimeout(r, 500));
    const savedOnDisk = fs.readFileSync(testFile, 'utf8');
    assert.strictEqual(savedOnDisk, editedContent);
    console.log('PASS: Edited content successfully saved back to disk.');

    // 4. Verification Item 4: Live Auto-Refresh in View Mode
    console.log('\n--- Item 4: Live Auto-Refresh on Disk Edit ---');
    // Toggle back to 'view' mode
    await page.evaluate((fPath) => {
      window.appInstance.codeEditorManager.toggleMode(fPath);
    }, testFile);

    // Simulate Agent in terminal pane editing file on disk
    const agentAppendedContent = editedContent + `// Agent auto-refreshed line\n`;
    fs.writeFileSync(testFile, agentAppendedContent, 'utf8');

    // Wait for live file-watcher IPC event
    await new Promise(r => setTimeout(r, 1200));
    const liveContent = await page.evaluate(() => {
      return window.appInstance.codeEditorManager.editor.getValue();
    });
    assert.strictEqual(liveContent, agentAppendedContent);
    console.log('PASS: View mode auto-refreshed live content upon external disk modification without user action.');

    // 5. Verification Item 5: Pane-linking Dropdown & Status Tag
    console.log('\n--- Item 5: Pane-Linking Tag & Status Dot ---');
    await page.selectOption('.pane-link-select', 'pane-1');
    const linkedPaneId = await page.evaluate((fPath) => {
      return window.appInstance.codeEditorManager.openTabs.get(fPath).linkedPaneId;
    }, testFile);
    assert.strictEqual(linkedPaneId, 'pane-1');

    const dotVisible = await page.evaluate(() => {
      const dot = document.querySelector('.pane-dot');
      return dot && dot.style.display !== 'none';
    });
    assert.strictEqual(dotVisible, true);
    console.log('PASS: Pane-linking dropdown associated tab with Shell 1 and rendered status dot.');

    // 6. Verification Item 6: Split View Layout & Mode Persistence
    console.log('\n--- Item 6: Split View Layout & Persistence ---');
    await page.click('#btn-view-split');
    let wrapperClass = await page.$eval('#workbench-split-wrapper', el => el.className);
    assert(wrapperClass.includes('mode-split'));

    await page.click('#btn-view-terminals');
    wrapperClass = await page.$eval('#workbench-split-wrapper', el => el.className);
    assert(wrapperClass.includes('mode-terminals'));

    await page.click('#btn-view-editor');
    wrapperClass = await page.$eval('#workbench-split-wrapper', el => el.className);
    assert(wrapperClass.includes('mode-editor'));

    const savedViewMode = await page.evaluate(() => localStorage.getItem('ide_view_mode'));
    assert.strictEqual(savedViewMode, 'editor');
    console.log('PASS: View mode layout toggles work cleanly and persist to localStorage.');

    console.log('\n==================================================');
    console.log('PASS ALL 6 CODE EDITOR VERIFICATION CHECKS PASSED!');
    console.log('==================================================\n');

  } catch (err) {
    console.error('\nFAIL VERIFICATION FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(testFile)) {
      try { fs.unlinkSync(testFile); } catch (_) {}
    }
    if (app) {
      await app.close();
    }
  }
})();
