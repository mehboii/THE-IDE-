/* End-to-end smoke test: Electron renderer, node-pty, tmux lifecycle, and reattach. */
const { _electron: electron } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const marker = 'hello-sandbox-test';
const env = { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function tmuxHas(name) { try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; } }
async function launch() {
  const app = await electron.launch({ args: [root], env });
  let page;
  for (let i = 0; i < 20; i++) {
    const windows = app.windows();
    page = windows.find((w) => w.url().includes('index.html'));
    if (page) break;
    await sleep(100);
  }
  if (!page) page = await app.firstWindow();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.waitForSelector('.terminal-pane'); return { app, page, errors };
}
async function waitForBuffer(page, paneId, text) {
  for (let i = 0; i < 80; i++) {
    const found = await page.evaluate(({ paneId, text }) => {
      const terminal = window.appInstance.panes.get(paneId)?.terminal;
      for (let row = 0; terminal && row < terminal.buffer.active.length; row++) if (terminal.buffer.active.getLine(row)?.translateToString(true).includes(text)) return true;
      return false;
    }, { paneId, text });
    if (found) return; await sleep(100);
  } throw new Error(`Terminal output did not contain ${text}`);
}
async function verifyLiveCustomEndpoint(page) {
  const endpoint = process.env.CUSTOM_MODEL_TEST_URL;
  if (!endpoint) {
    console.log('SKIP custom endpoint integration: CUSTOM_MODEL_TEST_URL is not configured.');
    return;
  }
  const parsed = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('CUSTOM_MODEL_TEST_URL must point to a loopback test endpoint.');
  const type = process.env.CUSTOM_MODEL_TEST_TYPE === 'ollama' ? 'ollama' : 'openai';
  const model = {
    id: 'smoke-live-custom-model', name: 'Live endpoint smoke test', host: endpoint.replace(/\/$/, ''), port: '', type,
    model: process.env.CUSTOM_MODEL_TEST_MODEL || 'test-model', apiKey: process.env.CUSTOM_MODEL_TEST_API_KEY || ''
  };
  const connection = await page.evaluate((configured) => window.electronAPI.testCustomModel(configured), model);
  if (!connection.success) throw new Error(`Custom endpoint connection failed: ${connection.error}`);
  await page.evaluate((configured) => window.appInstance.createPane({ id: 'smoke-live-custom-model', customModel: configured }), model);
  const pane = page.locator('[data-pane-id="smoke-live-custom-model"]');
  await pane.locator('textarea').fill(process.env.CUSTOM_MODEL_TEST_PROMPT || 'Reply with a short smoke-test acknowledgement.');
  await pane.locator('.chat-composer button').click();
  await pane.locator('.chat-message.assistant:not(:empty)').waitFor({ timeout: 20_000 });
  console.log('PASS live custom endpoint response rendered in a custom model pane');
  await page.evaluate(() => window.appInstance.removePane('smoke-live-custom-model'));
}
(async () => {
  try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch (_) {}
  let run = await launch();
  const paneCount = await run.page.locator('.terminal-pane').count();
  if (paneCount !== 4) throw new Error(`Expected 4 default panes, received ${paneCount}`);
  console.log(`PASS grid rendered ${paneCount} panes`);
  await verifyLiveCustomEndpoint(run.page);
  await run.page.evaluate(() => window.appInstance.createPane({ id: 'smoke-pty', label: 'Smoke PTY', agentId: 'shell' }));
  await run.page.evaluate(() => window.electronAPI.writePty('smoke-pty', 'echo hello-sandbox-test\r'));
  await waitForBuffer(run.page, 'smoke-pty', marker); console.log('PASS node-pty command output reached xterm buffer');
  await run.page.evaluate(() => window.electronAPI.destroyPty('smoke-pty', true)); await sleep(250);
  if (tmuxHas('ide-smoke-pty')) throw new Error('tmux session survived requested kill');
  console.log('PASS pane kill terminated underlying tmux session');
  await run.page.evaluate(() => window.appInstance.createPane({ id: 'smoke-persist', label: 'Persistent', agentId: 'shell' }));
  if (!tmuxHas('ide-smoke-persist')) throw new Error('persistent tmux session was not created');
  await run.app.close(); if (!tmuxHas('ide-smoke-persist')) throw new Error('tmux session did not survive app close');
  console.log('PASS tmux session survived Electron shutdown');
  run = await launch(); const orphans = await run.page.evaluate(() => window.electronAPI.listOrphans());
  if (!orphans.includes('ide-smoke-persist')) throw new Error(`Expected orphan not found: ${orphans.join(', ')}`);
  await run.page.evaluate(() => window.appInstance.createPane({ id: 'smoke-persist', label: 'Reattached', agentId: 'shell', customSessionName: 'ide-smoke-persist' }));
  await run.page.evaluate(() => window.electronAPI.writePty('smoke-persist', 'echo reattached-sandbox-test\r'));
  await waitForBuffer(run.page, 'smoke-persist', 'reattached-sandbox-test');
  if (run.errors.length) throw new Error(`Renderer console errors: ${run.errors.join(' | ')}`);
  console.log('PASS orphan detected and reattached with usable terminal');
  await run.page.evaluate(() => window.electronAPI.killAllSessions()); await run.app.close(); console.log('PASS smoke suite complete');
})().catch((error) => { console.error('FAIL smoke suite:', error.stack || error); process.exitCode = 1; });
