/* End-to-end custom chat and Ollama agent-loop coverage using a loopback mock. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');

function response(res, message) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ message, done: true }) + '\n'); }
function tool(name, args) { return { content: '', tool_calls: [{ function: { name, arguments: args } }] }; }
function mockServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') return response(res, { content: 'tags' });
    if (req.method === 'POST' && req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
    if (req.method === 'GET' && req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock-openai' }] }));
    if (req.method === 'POST' && req.url === '/v1/chat/completions') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Mock OpenAI answer' } }] })}\n\ndata: [DONE]\n\n`); }
    if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
      const body = JSON.parse(raw); const messages = body.messages || []; const scenario = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const toolResult = [...messages].reverse().find((m) => m.role === 'tool');
      if (!body.tools) return response(res, { content: 'Mock streamed answer' });
      if (scenario.includes('loop forever')) return response(res, tool('list_directory', { path: '.' }));
      if (!toolResult) {
        if (scenario.includes('traversal')) return response(res, tool('write_file', { path: '../../etc/passwd', content: 'nope' }));
        if (scenario.includes('destructive')) return response(res, tool('run_command', { command: 'rm -rf /' }));
        if (scenario.includes('deny')) return response(res, tool('write_file', { path: 'denied.txt', content: 'should not write' }));
        return response(res, tool('write_file', { path: 'generated/agent.txt', content: 'written by mock agent' }));
      }
      const result = JSON.parse(toolResult.content);
      return response(res, { content: result.ok ? 'Tool completed naturally.' : `Tool error received: ${result.error || result.stderr}` });
    });
  });
}

(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
  const server = mockServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const app = await electron.launch({ args: [root], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow(); await page.waitForSelector('.terminal-pane');
    const plain = { id: 'plain', name: 'Mock plain chat', host: '127.0.0.1', port: String(port), type: 'ollama', model: 'mock-llama', apiKey: '' };
    const agent = { id: 'agent', name: 'Mock Qwen agent', host: '127.0.0.1', port: String(port), type: 'ollama', model: 'qwen3:8b', apiKey: '', toolCapable: true };
    await page.evaluate((models) => window.electronAPI.saveCustomModels(models), [plain, agent]);
    const connected = await page.evaluate((m) => window.electronAPI.testCustomModel(m), agent);
    if (!connected.success || !connected.toolCapable) throw new Error('Ollama tool capability detection failed');
    console.log('PASS Ollama capability check reports tool support');
    const closed = await page.evaluate((m) => window.electronAPI.testCustomModel({ ...m, port: '65530' }), agent);
    if (closed.success || !closed.error.includes('ECONNREFUSED')) throw new Error('closed port did not report connection failure');
    console.log('PASS clear closed-port error');
    await page.evaluate(({ model, cwd }) => window.appInstance.createPane({ id: 'agent-pane', label: 'Agent', customModel: model, cwd }), { model: agent, cwd: project });
    const chat = page.locator('[data-pane-id="agent-pane"]'); await chat.locator('textarea').fill('write a file'); await chat.locator('.chat-composer button').click();
    await chat.locator('.tool-approval .btn-primary').click(); await page.waitForFunction(() => [...document.querySelectorAll('[data-pane-id="agent-pane"] .chat-message.assistant')].some((el) => el.textContent.includes('Tool completed naturally.')));
    const written = fs.readFileSync(path.join(project, 'generated/agent.txt'), 'utf8'); if (written !== 'written by mock agent') throw new Error('tool write did not create expected file');
    console.log('PASS write_file approval, execution, tool-result loop, and natural termination');
    await chat.locator('textarea').fill('traversal'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-primary').click(); await page.waitForFunction(() => [...document.querySelectorAll('[data-pane-id="agent-pane"] .chat-message.assistant')].some((el) => el.textContent.includes('escapes the project root')));
    console.log('PASS traversal write rejected and error returned to model');
    await chat.locator('.tool-approve-toggle input').check(); await chat.locator('textarea').fill('destructive'); await chat.locator('.chat-composer button').click(); await page.waitForFunction(() => [...document.querySelectorAll('[data-pane-id="agent-pane"] .chat-message.assistant')].some((el) => el.textContent.includes('Destructive removal'))); console.log('PASS rm -rf / blocked before execution even with full auto-approve');
    await chat.locator('.tool-approve-toggle input').uncheck();
    await chat.locator('textarea').fill('deny'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-danger').click(); await page.waitForFunction(() => [...document.querySelectorAll('[data-pane-id="agent-pane"] .chat-message.assistant')].some((el) => el.textContent.includes('User denied'))); if (fs.existsSync(path.join(project, 'denied.txt'))) throw new Error('denied tool wrote a file'); console.log('PASS explicit deny pauses and prevents write');
    await page.evaluate(({ model, cwd }) => window.appInstance.createPane({ id: 'loop-pane', label: 'Loop', customModel: { ...model, maxIterations: 3 }, cwd }), { model: agent, cwd: project });
    const loop = page.locator('[data-pane-id="loop-pane"]'); await loop.locator('.tool-approve-toggle input').check(); await loop.locator('textarea').fill('loop forever'); await loop.locator('.chat-composer button').click(); await loop.getByText('Max tool-call iterations reached (3)').waitFor(); console.log('PASS max iteration cap stops repeated tool calls');
  } finally { await app.close(); if (server.listening) await new Promise((resolve) => server.close(resolve)); fs.rmSync(project, { recursive: true, force: true }); }
})().catch((error) => { console.error('FAIL custom model suite:', error.stack || error); process.exitCode = 1; });
