/* Sandboxed end-to-end coverage for persisted custom endpoints and streamed panes. */
const http = require('http');
const { _electron: electron } = require('playwright');
const path = require('path');
const root = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mockServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: [{ name: 'mock-llama' }] })); }
    if (req.method === 'POST' && req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Mock streamed ' }, done: false }) + '\n');
      return setTimeout(() => res.end(JSON.stringify({ message: { content: 'answer' }, done: true }) + '\n'), 20);
    }
    if (req.method === 'GET' && req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'mock-openai' }] })); }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Mock OpenAI ' } }] }) + '\n\n');
      return setTimeout(() => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }) + '\n\ndata: [DONE]\n\n'), 20);
    }
    res.writeHead(404); res.end('not found');
  });
}

(async () => {
  const server = mockServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const app = await electron.launch({ args: [root], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow(); await page.waitForSelector('.terminal-pane');
    const model = { id: 'sandbox-mock', name: 'Sandbox Mock Ollama', host: '127.0.0.1', port: String(port), type: 'ollama', model: 'mock-llama', apiKey: '' };
    await page.evaluate((m) => window.electronAPI.saveCustomModels([m]), model);
    await page.reload(); await page.waitForSelector('.terminal-pane');
    const success = await page.evaluate((m) => window.electronAPI.testCustomModel(m), model);
    if (!success.success) throw new Error(`connection test unexpectedly failed: ${success.error}`);
    console.log('PASS connection test reports success against mock Ollama');
    const openAiSuccess = await page.evaluate((m) => window.electronAPI.testCustomModel({ ...m, id: 'sandbox-openai', type: 'openai', model: 'mock-openai' }), model);
    if (!openAiSuccess.success) throw new Error(`OpenAI-compatible connection test unexpectedly failed: ${openAiSuccess.error}`);
    console.log('PASS OpenAI-compatible /v1/models connection path succeeds');
    const failure = await page.evaluate((m) => window.electronAPI.testCustomModel({ ...m, port: '65530' }), model);
    if (failure.success || !failure.error) throw new Error('closed-port test did not return a useful error');
    console.log(`PASS closed port reports clear error: ${failure.error}`);
    await page.locator('.btn-run-agent').first().click();
    await page.locator('#run-agent-select').selectOption('custom:sandbox-mock'); await page.locator('#btn-run-agent-single').click();
    await page.waitForSelector('.custom-model-pane');
    const chat = page.locator('.custom-model-pane');
    if (await chat.locator('.xterm-wrapper').count()) throw new Error('custom pane incorrectly contains xterm');
    await chat.locator('textarea').fill('hello'); await chat.locator('.chat-composer button').click();
    await page.waitForFunction(() => document.querySelector('.custom-model-pane .chat-message.assistant')?.textContent === 'Mock streamed answer');
    console.log('PASS Run Agent opens chat pane and displays streamed mock response');
    if (await page.locator('.terminal-pane').count() < 4) throw new Error('chat pane did not coexist with terminal grid');
    await chat.locator('.btn-kill-pane').click(); await chat.locator('.btn-restart-pane').click();
    await page.waitForFunction(() => document.querySelector('.custom-model-pane')?.classList.contains('focused'));
    console.log('PASS kill/restart reconnects custom pane without breaking grid');
    await page.locator('#btn-preset-3x2').click();
    if (!(await chat.boundingBox())) throw new Error('chat pane vanished after grid resize preset');
    await page.locator('#btn-toggle-broadcast').click(); await page.locator('#btn-toggle-broadcast').click();
    console.log('PASS chat pane survives grid resize and broadcast toggle');
    await new Promise((resolve) => server.close(resolve));
    await chat.locator('.btn-reconnect').first().click();
    await page.waitForSelector('.chat-disconnected:not(.hidden)');
    const error = await chat.locator('.disconnect-detail').textContent(); if (!error.trim()) throw new Error('disconnect state omitted error detail');
    console.log(`PASS offline state and Reconnect show error: ${error.trim()}`);
    await page.locator('#btn-kill-all').click(); await page.waitForFunction(() => document.querySelectorAll('.terminal-pane').length === 0);
    console.log('PASS Kill All clears mixed terminal/chat grid');
  } finally { await app.close(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error('FAIL custom model suite:', error.stack || error); process.exitCode = 1; });
