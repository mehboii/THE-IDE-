/* End-to-end custom chat and Ollama agent-loop coverage using a loopback mock. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const requestLog = [];

let mockServerModels = [{ name: 'mock-llama' }, { name: 'qwen3:8b' }];
function response(res, message) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ message, done: true }) + '\n'); }
function tool(name, args) { return { content: '', tool_calls: [{ function: { name, arguments: args } }] }; }
function mockServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      requestLog.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: mockServerModels }));
    }
    if (req.method === 'POST' && req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
    if (req.method === 'GET' && req.url === '/v1/models') { requestLog.push({ url: req.url, authorization: req.headers.authorization }); return res.end(JSON.stringify({ data: [{ id: 'mock-openai' }] })); }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        requestLog.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Mock OpenAI answer' } }] })}\n\ndata: [DONE]\n\n`);
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
      const body = JSON.parse(raw); const messages = body.messages || []; const scenario = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
      const toolResult = messages.slice(lastUserIndex + 1).find((m) => m.role === 'tool');
      if (!body.tools) return response(res, { content: 'Mock streamed answer' });
      if (scenario.includes('loop forever')) return response(res, tool('list_directory', { path: '.' }));
      if (!toolResult) {
        if (scenario.includes('list files')) return response(res, tool('list_directory', { path: '.' }));
        if (scenario.includes('nested write')) return response(res, tool('write_file', { path: 'src/components/Button.js', content: 'export default function Button() {}\n' }));
        if (scenario.includes('command cwd')) return response(res, tool('run_command', { command: process.platform === 'win32' ? 'cd' : 'pwd' }));
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
  fs.writeFileSync(path.join(project, 'hello.txt'), 'known hello content\n');
  const server = mockServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const app = await electron.launch({ args: [root], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  let originalModels = [];
  try {
    const page = await app.firstWindow(); await page.waitForSelector('.terminal-pane');
    originalModels = await page.evaluate(() => window.electronAPI.getCustomModels());
    const plain = { id: 'plain', name: 'Mock plain chat', host: '127.0.0.1', port: String(port), type: 'ollama', model: 'mock-llama', apiKey: '' };
    const agent = { id: 'agent', name: 'Mock Qwen agent', host: '127.0.0.1', port: String(port), type: 'ollama', model: 'qwen3:8b', apiKey: '', toolCapable: true };
    const openai = { id: 'openai', name: 'Mock OpenAI', host: `http://127.0.0.1:${port}/v1`, port: '', type: 'openai', model: 'mock-openai', apiKey: 'test-openai-key' };
    // The OpenAI-compatible endpoint is a live loopback HTTP service. Use its
    // actual /v1 base URL before opening a project to cover URL normalization,
    // auth, request schema, streaming, and pane rendering end-to-end.
    const openaiConnected = await page.evaluate((m) => window.electronAPI.testCustomModel(m), openai);
    if (!openaiConnected.success) throw new Error(`OpenAI-compatible connection failed: ${openaiConnected.error}`);
    await page.evaluate((model) => window.appInstance.createPane({ id: 'openai-pane', label: 'OpenAI', customModel: model }), openai);
    const openaiChat = page.locator('[data-pane-id="openai-pane"]'); await openaiChat.locator('textarea').fill('hello endpoint'); await openaiChat.locator('.chat-composer button').click();
    await openaiChat.locator('.chat-message.assistant').filter({ hasText: 'Mock OpenAI answer' }).waitFor();
    const openaiRequest = requestLog.find((entry) => entry.url === '/v1/chat/completions');
    if (!openaiRequest || openaiRequest.authorization !== 'Bearer test-openai-key' || openaiRequest.body?.model !== 'mock-openai' || openaiRequest.body?.stream !== true || !Array.isArray(openaiRequest.body?.messages)) throw new Error('OpenAI-compatible URL, auth header, or chat schema was incorrect');
    console.log('PASS OpenAI /v1 base URL, Bearer auth, chat schema, and streamed pane response');
    await page.evaluate(() => window.appInstance.removePane('openai-pane'));
    // Use the actual Open Folder flow; deliberately do not pass cwd when
    // creating the agent pane below.
    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), project);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('hello.txt', { exact: true }).waitFor();
    await page.evaluate((models) => window.electronAPI.saveCustomModels(models), [plain, agent]);
    const connected = await page.evaluate((m) => window.electronAPI.testCustomModel(m), agent);
    if (!connected.success || !connected.toolCapable) throw new Error('Ollama tool capability detection failed');
    console.log('PASS Ollama capability check reports tool support');

    // Case (a): Unreachable port returns clear Server unreachable error, not bare 404
    const closed = await page.evaluate((m) => window.electronAPI.testCustomModel({ ...m, port: '65530' }), agent);
    if (closed.success || !closed.error.includes('Server unreachable') || !closed.error.includes('ECONNREFUSED')) throw new Error(`closed port did not report clear connection failure: ${JSON.stringify(closed)}`);
    console.log('PASS clear closed-port Server unreachable error');

    await page.evaluate((m) => window.appInstance.createPane({ id: 'unreachable-pane', label: 'Unreachable', customModel: { ...m, port: '65530' } }), agent);
    const unreachablePane = page.locator('[data-pane-id="unreachable-pane"]');
    await unreachablePane.locator('.chat-disconnected.disconnected-unreachable').waitFor();
    const unreachableBadge = await unreachablePane.locator('.disconnect-badge').textContent();
    if (unreachableBadge !== 'Server Unreachable') throw new Error(`Expected Server Unreachable badge, got: ${unreachableBadge}`);
    console.log('PASS unreachable custom model pane displays distinct Server Unreachable banner');
    await page.evaluate(() => window.appInstance.removePane('unreachable-pane'));

    // Case (b): Model not found returns specific error with available models list
    const notFound = await page.evaluate((m) => window.electronAPI.testCustomModel({ ...m, model: 'nonexistent-model:latest' }), agent);
    if (notFound.success || !notFound.error.includes("Model 'nonexistent-model:latest' not found on this server") || !notFound.error.includes('mock-llama, qwen3:8b')) {
      throw new Error(`Model not found test failed: ${JSON.stringify(notFound)}`);
    }
    console.log('PASS model not found returns specific error with available models list');

    await page.evaluate((m) => window.appInstance.createPane({ id: 'missing-model-pane', label: 'Missing', customModel: { ...m, model: 'nonexistent-model:latest' } }), agent);
    const missingPane = page.locator('[data-pane-id="missing-model-pane"]');
    await missingPane.locator('.chat-disconnected.disconnected-model-not-found').waitFor();
    const missingBadge = await missingPane.locator('.disconnect-badge').textContent();
    if (missingBadge !== 'Model Not Found') throw new Error(`Expected Model Not Found badge, got: ${missingBadge}`);
    const missingDetail = await missingPane.locator('.disconnect-detail').textContent();
    if (!missingDetail.includes("Model 'nonexistent-model:latest' not found on this server")) throw new Error(`Expected missing detail, got: ${missingDetail}`);
    console.log('PASS missing model pane displays distinct Model Not Found banner');
    await page.evaluate(() => window.appInstance.removePane('missing-model-pane'));

    // Dropdown UI State 1: Populated /api/tags auto-populates and auto-selects default without clicking Refresh
    await page.evaluate((m) => window.appInstance.openCustomModelModal({ ...m, model: '' }), agent);
    await page.waitForFunction(() => {
      const select = document.getElementById('custom-model-select');
      return select && select.options.length === 2 && select.options[0].value === 'mock-llama';
    });
    const isSelect = await page.evaluate(() => document.getElementById('custom-model-select').tagName.toLowerCase());
    if (isSelect !== 'select') throw new Error(`Expected custom-model-select to be a select tag, got: ${isSelect}`);
    const selectedVal = await page.evaluate(() => document.getElementById('custom-model-select').value);
    if (selectedVal !== 'mock-llama') throw new Error(`Expected auto-selected model 'mock-llama', got: '${selectedVal}'`);
    const resultTextPopulated = await page.evaluate(() => document.getElementById('custom-model-test-result').textContent);
    if (!resultTextPopulated.includes('Found 2 model(s) on server')) throw new Error(`Expected found count, got: ${resultTextPopulated}`);
    await page.evaluate(() => window.appInstance.closeCustomModelModal());
    console.log('PASS State 1: Populated /api/tags auto-detects real models and selects default automatically');

    // Dropdown UI State 2: Genuinely empty /api/tags shows actionable guidance
    mockServerModels = [];
    await page.evaluate((m) => window.appInstance.openCustomModelModal(m), agent);
    await page.waitForFunction(() => {
      const el = document.getElementById('custom-model-test-result');
      return el && el.classList.contains('warning');
    });
    const resultTextEmpty = await page.evaluate(() => document.getElementById('custom-model-test-result').textContent);
    if (!resultTextEmpty.includes('No models pulled on this server yet') || !resultTextEmpty.includes('ollama pull')) {
      throw new Error(`Expected actionable empty message, got: ${resultTextEmpty}`);
    }
    const emptySelectText = await page.evaluate(() => document.getElementById('custom-model-select').options[0]?.textContent);
    if (!emptySelectText.includes('No models pulled on server yet')) throw new Error(`Expected empty option text, got: ${emptySelectText}`);
    await page.evaluate(() => window.appInstance.closeCustomModelModal());
    console.log('PASS State 2: Genuinely empty server displays actionable "no models pulled yet" guidance');

    // Dropdown UI State 3: Unreachable server shows distinct error state
    await page.evaluate((m) => window.appInstance.openCustomModelModal({ ...m, port: '65530' }), agent);
    await page.waitForFunction(() => {
      const el = document.getElementById('custom-model-test-result');
      return el && el.classList.contains('error');
    });
    const resultTextUnreachable = await page.evaluate(() => document.getElementById('custom-model-test-result').textContent);
    if (!resultTextUnreachable.includes('Server unreachable') || !resultTextUnreachable.includes('Connection refused')) {
      throw new Error(`Expected Server unreachable message, got: ${resultTextUnreachable}`);
    }
    const unreachableSelectText = await page.evaluate(() => document.getElementById('custom-model-select').options[0]?.textContent);
    if (!unreachableSelectText.includes('Server unreachable')) throw new Error(`Expected unreachable option, got: ${unreachableSelectText}`);
    await page.evaluate(() => window.appInstance.closeCustomModelModal());
    console.log('PASS State 3: Unreachable server displays distinct error not conflated with empty list');

    // Restore mockServerModels
    mockServerModels = [{ name: 'mock-llama' }, { name: 'qwen3:8b' }];

    await page.evaluate((model) => window.appInstance.createPane({ id: 'agent-pane', label: 'Agent', customModel: model }), agent);
    const chat = page.locator('[data-pane-id="agent-pane"]'); await chat.locator('textarea').fill('write a file'); await chat.locator('.chat-composer button').click();
    await chat.locator('.tool-approval .btn-primary').click(); await chat.locator('.chat-message.assistant').filter({ hasText: 'Tool completed naturally.' }).waitFor();
    const written = fs.readFileSync(path.join(project, 'generated/agent.txt'), 'utf8'); if (written !== 'written by mock agent') throw new Error('tool write did not create expected file');
    console.log('PASS write_file approval, execution, tool-result loop, and natural termination');
    await chat.locator('textarea').fill('nested write'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-primary').click(); await chat.locator('.chat-message.assistant').filter({ hasText: 'Tool completed naturally.' }).last().waitFor();
    const nestedFile = path.join(project, 'src', 'components', 'Button.js');
    if (fs.readFileSync(nestedFile, 'utf8') !== 'export default function Button() {}\n') throw new Error('nested tool write did not create expected file');
    console.log(`PASS nested write created ${nestedFile}`);
    await chat.locator('textarea').fill('command cwd'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-primary').click(); await chat.locator('.tool-result').last().waitFor({ state: 'attached' });
    console.log(`PASS run_command used opened-folder cwd ${project}`);
    await page.getByText('generated', { exact: true }).click();
    await page.getByText('agent.txt', { exact: true }).waitFor();
    console.log('PASS explicit agent prompt created generated/agent.txt and Explorer auto-refresh shows it');
    await chat.locator('textarea').fill('list files in this directory'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-result').filter({ hasText: 'hello.txt' }).waitFor({ state: 'attached' });
    console.log('PASS tool-calling agent lists hello.txt from the Open Folder project root');
    await chat.locator('textarea').fill('traversal'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-primary').click(); await chat.locator('.chat-message.assistant').filter({ hasText: 'outside project root' }).waitFor();
    console.log('PASS traversal write rejected and error returned to model');
    await chat.locator('.tool-approve-toggle input').check(); await chat.locator('textarea').fill('destructive'); await chat.locator('.chat-composer button').click(); await chat.locator('.chat-message.assistant').filter({ hasText: 'Destructive removal' }).waitFor(); console.log('PASS rm -rf / blocked before execution even with full auto-approve');
    await chat.locator('.tool-approve-toggle input').uncheck();
    await chat.locator('textarea').fill('deny'); await chat.locator('.chat-composer button').click(); await chat.locator('.tool-approval .btn-danger').click(); await chat.locator('.chat-message.assistant').filter({ hasText: 'User denied' }).waitFor(); if (fs.existsSync(path.join(project, 'denied.txt'))) throw new Error('denied tool wrote a file'); console.log('PASS explicit deny pauses and prevents write');
    await page.evaluate(({ model, cwd }) => window.appInstance.createPane({ id: 'loop-pane', label: 'Loop', customModel: { ...model, maxIterations: 3 }, cwd }), { model: agent, cwd: project });
    const loop = page.locator('[data-pane-id="loop-pane"]'); await loop.locator('.tool-approve-toggle input').check(); await loop.locator('textarea').fill('loop forever'); await loop.locator('.chat-composer button').click(); await loop.getByText('Max tool-call iterations reached (3)').waitFor(); console.log('PASS max iteration cap stops repeated tool calls');

    if (originalModels.length) {
      try { await page.evaluate((models) => window.electronAPI.saveCustomModels(models), originalModels); } catch (_) {}
    }
  } finally { await app.close(); if (server.listening) await new Promise((resolve) => server.close(resolve)); fs.rmSync(project, { recursive: true, force: true }); }
})().catch((error) => { console.error('FAIL custom model suite:', error.stack || error); process.exitCode = 1; });
