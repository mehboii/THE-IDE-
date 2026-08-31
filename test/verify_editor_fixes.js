const { _electron: electron } = require('/Volumes/LINUX MINT/vs code /node_modules/playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = '/Volumes/LINUX MINT/vs code ';
const editTestFile = path.join(root, 'test', 'temp_edit_test.js');
const saveAsTestFile = path.join(root, 'test', 'temp_saveas_test.js');

(async () => {
  console.log('=== STARTING EDITOR & TERMINAL NAVIGATION VERIFICATION ===\n');

  // Prepare temp edit files
  const initialText = `// Original Content\nconst x = 42;\nmodule.exports = { x };\n`;
  fs.writeFileSync(editTestFile, initialText, 'utf8');
  if (fs.existsSync(saveAsTestFile)) fs.unlinkSync(saveAsTestFile);

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
    console.log('PASS App launched & renderer connected.');

    await page.waitForFunction(() => window.appInstance && window.appInstance.codeEditorManager, { timeout: 10000 });
    console.log('PASS AppController, FileExplorer, and CodeEditorManager initialized.');

    // ------------------------------------------------------------------------
    // Verification 1: Open 5 real files from disk, check genuine content & syntax language
    // ------------------------------------------------------------------------
    console.log('\n--- Test 1: Opening 5 Real Files & Syntax Models ---');
    const targetFiles = [
      { rel: 'package.json', lang: 'json' },
      { rel: 'main/index.js', lang: 'javascript' },
      { rel: 'renderer/styles.css', lang: 'css' },
      { rel: 'renderer/index.html', lang: 'html' },
      { rel: 'README.md', lang: 'markdown' }
    ];

    for (const f of targetFiles) {
      const absPath = path.join(root, f.rel);
      const expectedDisk = fs.readFileSync(absPath, 'utf8');

      await page.evaluate((p) => window.appInstance.codeEditorManager.openFile(p), absPath);
      await new Promise(r => setTimeout(r, 300));

      const loadedContent = await page.evaluate(() => window.appInstance.codeEditorManager.editor.getValue());
      const detectedLang = await page.evaluate((p) => {
        const tab = window.appInstance.codeEditorManager.openTabs.get(p);
        return tab ? tab.language : null;
      }, absPath);

      assert.strictEqual(loadedContent, expectedDisk, `Content for ${f.rel} must match disk content exactly`);
      assert.strictEqual(detectedLang, f.lang, `Language for ${f.rel} must be ${f.lang}`);
      console.log(`  PASS Verified genuine disk content & language (${detectedLang}) for: ${f.rel}`);
    }
    console.log('PASS: 5 real files loaded genuine disk content with correct syntax language models.');

    // ------------------------------------------------------------------------
    // Verification 2: File > Open Folder via dialog
    // ------------------------------------------------------------------------
    console.log('\n--- Test 2: File > Open Folder Native Dialog ---');
    await page.evaluate(async (p) => {
      await window.appInstance.fileExplorer.setRootDirectory(p, true);
    }, path.join(root, 'main'));

    const rootHeaderTitle = await page.$eval('.file-tree-root-title', el => el.textContent.trim());
    assert(rootHeaderTitle.includes('main'), 'Tree root header should update to selected folder "main"');
    console.log(`PASS: Open Folder set root directory to: ${rootHeaderTitle}`);

    // Restore root
    await page.evaluate(async (p) => {
      await window.appInstance.fileExplorer.setRootDirectory(p, true);
    }, root);

    // ------------------------------------------------------------------------
    // Verification 3: Edit & Save to Disk
    // ------------------------------------------------------------------------
    console.log('\n--- Test 3: Edit File & Save (Ctrl+S) ---');
    await page.evaluate((p) => window.appInstance.codeEditorManager.openFile(p), editTestFile);
    await page.evaluate((p) => window.appInstance.codeEditorManager.toggleMode(p), editTestFile);

    const editedText = initialText + `// Added Line via Editor Test\n`;
    await page.evaluate((txt) => {
      window.appInstance.codeEditorManager.editor.setValue(txt);
    }, editedText);

    await page.evaluate(() => window.appInstance.codeEditorManager.saveActiveFile());
    await new Promise(r => setTimeout(r, 500));

    const diskAfterSave = fs.readFileSync(editTestFile, 'utf8');
    assert.strictEqual(diskAfterSave, editedText);
    console.log('PASS: Saved edited file persisted to disk correctly.');

    // ------------------------------------------------------------------------
    // Verification 4: Save As...
    // ------------------------------------------------------------------------
    console.log('\n--- Test 4: Save As... ---');
    const saveAsText = editedText + `// Save As New Target\n`;
    await page.evaluate((txt) => {
      window.appInstance.codeEditorManager.editor.setValue(txt);
    }, saveAsText);

    // Set target save path via IPC for test mode
    await page.evaluate(async (newPath) => {
      await window.electronAPI.setTestSaveAsPath(newPath);
    }, saveAsTestFile);

    await page.evaluate(() => window.appInstance.codeEditorManager.saveAsActiveFile());
    await new Promise(r => setTimeout(r, 500));

    assert(fs.existsSync(saveAsTestFile), 'New file should exist at Save As path');
    const newFileContent = fs.readFileSync(saveAsTestFile, 'utf8');
    assert.strictEqual(newFileContent, saveAsText);

    // Original file should remain unchanged
    const originalFileContent = fs.readFileSync(editTestFile, 'utf8');
    assert.strictEqual(originalFileContent, editedText);
    console.log('PASS: Save As created new file with edited content while leaving original file untouched.');

    // ------------------------------------------------------------------------
    // Verification 5: Running Terminal Panes Preservation Across View Switches
    // ------------------------------------------------------------------------
    console.log('\n--- Test 5: Terminal Panes Preservation Across View Modes ---');
    await page.waitForFunction(() => window.appInstance.panes.size >= 4, { timeout: 10000 });
    const initialPaneIds = await page.evaluate(() => Array.from(window.appInstance.panes.keys()));
    console.log(`Initial active pane IDs (${initialPaneIds.length}):`, initialPaneIds);

    // Send marker text to Pane 1 to verify buffer output survives view mode switches
    const marker = `RUNNING_MARKER_${Date.now()}`;
    await page.evaluate(({ paneId, text }) => {
      window.electronAPI.writePty(paneId, `echo "${text}"\n`);
    }, { paneId: initialPaneIds[0], text: marker });

    await new Promise(r => setTimeout(r, 600));

    // Switch to Editor Only view
    console.log('Switching view mode to "Editor Only"...');
    await page.evaluate(() => window.appInstance.setViewMode('editor'));
    let isTerminalsVisible = await page.evaluate(() => {
      const p = document.getElementById('terminal-split-panel');
      return p && window.getComputedStyle(p).display !== 'none';
    });
    assert.strictEqual(isTerminalsVisible, false, 'Terminal panel should be hidden in Editor Only mode');

    // Switch back via Activity Bar "Terminals" button
    console.log('Clicking "Terminals" in Activity Bar...');
    await page.click('.activity-item[data-activity="terminal"]');

    isTerminalsVisible = await page.evaluate(() => {
      const p = document.getElementById('terminal-split-panel');
      return p && window.getComputedStyle(p).display !== 'none';
    });
    assert.strictEqual(isTerminalsVisible, true, 'Terminal panel should be restored when clicking Terminals in Activity Bar');

    const finalPaneIds = await page.evaluate(() => Array.from(window.appInstance.panes.keys()));
    assert.deepStrictEqual(finalPaneIds, initialPaneIds, 'Pane IDs must match initial set \u2014 zero panes destroyed or re-created');

    // Check buffer content in Pane 1
    const bufferContainsMarker = await page.evaluate(({ paneId, text }) => {
      const pane = window.appInstance.panes.get(paneId);
      if (!pane || !pane.terminal) return false;
      for (let i = 0; i < pane.terminal.buffer.active.length; i++) {
        const line = pane.terminal.buffer.active.getLine(i);
        if (line && line.translateToString(true).includes(text)) return true;
      }
      return false;
    }, { paneId: initialPaneIds[0], text: marker });

    assert.strictEqual(bufferContainsMarker, true, 'Terminal buffer and PTY session output must remain intact');
    console.log('PASS: All terminal panes, PTY processes, and scrollbacks remained intact without teardown across view mode switches.');

    console.log('\n==================================================');
    console.log('PASS ALL 5 BUG FIX VERIFICATION TESTS PASSED!');
    console.log('==================================================\n');

  } catch (err) {
    console.error('\nFAIL VERIFICATION FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(editTestFile)) try { fs.unlinkSync(editTestFile); } catch (_) {}
    if (fs.existsSync(saveAsTestFile)) try { fs.unlinkSync(saveAsTestFile); } catch (_) {}
    if (app) await app.close();
  }
})();
