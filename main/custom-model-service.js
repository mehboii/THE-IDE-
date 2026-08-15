const { randomUUID } = require('crypto');
const { TOOL_SCHEMA, executeTool, title } = require('./custom-model-tools');

const CONNECT_TIMEOUT_MS = 10_000;

function baseUrl(model) {
  const host = String(model.host || '').trim().replace(/\/$/, '');
  if (!host) throw new Error('Host/IP address is required.');
  const protocol = /^https?:\/\//i.test(host) ? '' : 'http://';
  const port = model.port ? `:${String(model.port).replace(/^:/, '')}` : '';
  return `${protocol}${host}${port}`;
}

async function request(url, options = {}, timeout = CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    // Node's fetch often exposes the useful network reason (for example
    // ECONNREFUSED) on `cause`, rather than its generic "fetch failed" text.
    const reason = error.name === 'AbortError' ? `Connection timed out after ${timeout / 1000}s` : (error.cause?.message || error.message);
    throw new Error(reason);
  } finally { clearTimeout(timer); }
}

const pendingApprovals = new Map();
const knownToolFamilies = /^(qwen3|qwen2\.5|llama3\.1|llama3\.2|mistral-nemo|mistral-small|command-r|hermes)/i;

function headers(model) {
  const value = { 'Content-Type': 'application/json' };
  if (model.apiKey) value.Authorization = `Bearer ${model.apiKey}`;
  return value;
}

function isToolCapable(model) { return model.type === 'ollama' && model.toolCapable !== false && knownToolFamilies.test(String(model.model || '')); }

async function modelCapability(model) {
  if (model.type !== 'ollama') return { supported: false, source: 'not-ollama' };
  try {
    const response = await request(`${baseUrl(model)}/api/show`, { method: 'POST', headers: headers(model), body: JSON.stringify({ name: model.model }) });
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body.capabilities)) return { supported: body.capabilities.includes('tools'), source: 'ollama' };
    }
  } catch (_) { /* capability endpoint is optional across Ollama versions */ }
  return { supported: knownToolFamilies.test(String(model.model || '')), source: 'known-family' };
}

async function testConnection(model) {
  try {
    const url = `${baseUrl(model)}${model.type === 'ollama' ? '/api/tags' : '/v1/models'}`;
    const response = await request(url, { headers: headers(model) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}${response.status === 401 || response.status === 403 ? ' — check API key' : ''}`);
    const capability = await modelCapability(model);
    return { success: true, message: `Connected to ${url}`, toolCapable: capability.supported, capabilitySource: capability.source };
  } catch (error) { return { success: false, error: error.message }; }
}

function parseToolCall(call) {
  const name = call?.function?.name || call?.name;
  const raw = call?.function?.arguments ?? call?.arguments ?? {};
  try { return { name, args: typeof raw === 'string' ? JSON.parse(raw) : raw }; } catch { return { name, args: {}, parseError: 'Tool arguments were not valid JSON.' }; }
}

function requestApproval(webContents, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingApprovals.delete(payload.callId); resolve(false); }, 120_000);
    pendingApprovals.set(payload.callId, (approved) => { clearTimeout(timer); resolve(Boolean(approved)); });
  });
}

function resolveApproval(callId, approved) { const resolve = pendingApprovals.get(callId); if (resolve) { pendingApprovals.delete(callId); resolve(approved); } return Boolean(resolve); }

async function readOllamaResponse(response, emit) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let content = ''; let toolCalls = [];
  while (true) {
    const { done, value } = await reader.read(); pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const item = JSON.parse(line); const message = item.message || {}; if (message.content) { content += message.content; emit(message.content); } if (Array.isArray(message.tool_calls)) toolCalls = toolCalls.concat(message.tool_calls); } catch (_) {}
    }
    if (done) break;
  }
  return { content, toolCalls };
}

async function streamOllamaAgent(webContents, paneId, requestId, model, messages, cwd, fullAutoApprove, maxIterations) {
  const history = messages.map(({ role, content }) => ({ role, content }));
  const agentic = isToolCapable(model);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await request(`${baseUrl(model)}/api/chat`, { method: 'POST', headers: headers(model), body: JSON.stringify({ model: model.model, messages: history, stream: true, ...(agentic ? { tools: TOOL_SCHEMA } : {}) }) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const answer = await readOllamaResponse(response, (token) => webContents.send('custom-model:token', { paneId, requestId, token }));
    history.push({ role: 'assistant', content: answer.content, ...(answer.toolCalls.length ? { tool_calls: answer.toolCalls } : {}) });
    if (!agentic || !answer.toolCalls.length) { webContents.send('custom-model:done', { paneId, requestId }); return; }
    for (let index = 0; index < answer.toolCalls.length; index += 1) {
      const call = parseToolCall(answer.toolCalls[index]); const callId = `${requestId}:${iteration}:${index}`;
      const needsApproval = ['write_file', 'run_command'].includes(call.name) && !fullAutoApprove;
      webContents.send('custom-model:tool-call', { paneId, requestId, callId, name: call.name, args: call.args, title: title(call.name, call.args), needsApproval });
      let result;
      if (call.parseError) result = { ok: false, error: call.parseError };
      else if (needsApproval && !(await requestApproval(webContents, { paneId, requestId, callId, name: call.name, args: call.args, title: title(call.name, call.args), needsApproval }))) result = { ok: false, error: 'User denied this tool call.' };
      else result = await executeTool(call.name, call.args, cwd);
      webContents.send('custom-model:tool-result', { paneId, requestId, callId, result });
      history.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(result) });
    }
  }
  webContents.send('custom-model:max-iterations', { paneId, requestId, maxIterations });
  webContents.send('custom-model:done', { paneId, requestId });
}

async function streamChat(webContents, paneId, model, messages, cwd, fullAutoApprove = false, maxIterations = 25) {
  const requestId = randomUUID();
  const url = `${baseUrl(model)}${model.type === 'ollama' ? '/api/chat' : '/v1/chat/completions'}`;
  const body = model.type === 'ollama'
    ? { model: model.model, messages, stream: true }
    : { model: model.model, messages, stream: true };
  try {
    if (model.type === 'ollama') return await streamOllamaAgent(webContents, paneId, requestId, model, messages, cwd, fullAutoApprove, Math.min(Math.max(Number(maxIterations) || 25, 1), 100));
    const response = await request(url, { method: 'POST', headers: headers(model), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}${response.status === 401 || response.status === 403 ? ' — check API key' : ''}`);
    if (!response.body) throw new Error('The endpoint returned no response stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const emit = (token) => webContents.send('custom-model:token', { paneId, requestId, token });
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!data || data === '[DONE]') continue;
        try {
          const item = JSON.parse(data);
          const token = model.type === 'ollama' ? item.message?.content : item.choices?.[0]?.delta?.content;
          if (token) emit(token);
        } catch (_) { /* incomplete/non-data SSE line */ }
      }
      if (done) break;
    }
    webContents.send('custom-model:done', { paneId, requestId });
  } catch (error) {
    webContents.send('custom-model:error', { paneId, requestId, error: error.message });
  }
  return { requestId };
}

module.exports = { testConnection, streamChat, resolveApproval };
