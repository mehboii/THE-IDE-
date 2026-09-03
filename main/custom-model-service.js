const { randomUUID } = require('crypto');
const { TOOL_SCHEMA, executeTool, title } = require('./custom-model-tools');
const projectRoot = require('./project-root');
const customModelStore = require('./custom-model-store');

const CONNECT_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 120_000;
const customModelTraceEnabled = process.env.IDE_CUSTOM_MODEL_TRACE === '1';
function customModelTrace(event, details = {}) {
  if (customModelTraceEnabled) console.log('[CUSTOM_MODEL_TRACE] ' + event + ' ' + JSON.stringify(details));
}
function modelConnection(model) {
  if (!model) return null;
  return { id: model.id || null, type: model.type || null, host: model.host || null, baseUrl: model.baseUrl || null, port: model.port || null, model: model.model || null, toolCapable: model.toolCapable };
}

function resolveLiveModel(capturedModel) {
  if (!capturedModel?.id) return capturedModel;
  const savedModel = customModelStore.list().find((candidate) => candidate.id === capturedModel.id);
  return savedModel || capturedModel;
}

function baseUrl(model) {
  // `host` is the original field name. `baseUrl` is also accepted so callers
  // can pass an OpenAI-compatible URL such as http://host:1234/v1 directly.
  const host = String(model.baseUrl || model.host || '').trim().replace(/\/$/, '');
  if (!host) throw new Error('Host/IP address is required.');
  const protocol = /^https?:\/\//i.test(host) ? '' : 'http://';
  const port = model.port ? `:${String(model.port).replace(/^:/, '')}` : '';
  return `${protocol}${host}${port}`;
}

function endpointUrl(model, path) {
  const base = baseUrl(model);
  // Accept both a host root and a standard OpenAI base URL ending in /v1.
  // Without this normalization, http://host/v1 silently became /v1/v1/\u2026 .
  if (model.type === 'openai' && /\/v1$/i.test(base) && /^\/v1\//i.test(path)) return `${base}${path.slice(3)}`;
  // Likewise, allow an Ollama API root to be supplied without duplicating /api.
  if (model.type === 'ollama' && /\/api$/i.test(base) && /^\/api\//i.test(path)) return `${base}${path.slice(4)}`;
  return `${base}${path}`;
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

const AGENT_SYSTEM_PROMPT = 'You are an autonomous coding assistant inside an IDE. '
  + 'You have access to tools: read_file, write_file, list_directory, and run_command. '
  + 'When asked to create, edit, or write a file, you MUST call the write_file tool with the correct path and content arguments. '
  + 'When asked to read a file, call read_file. When asked to list files, call list_directory. '
  + 'When asked to run a command, call run_command. '
  + 'Do NOT describe what you would do in prose or write code blocks instead of calling the tool. '
  + 'Always prefer tool calls over text explanations.';

// Small models (e.g. qwen2.5-coder:1.5b) often emit tool calls as JSON text
// in content rather than using Ollama's structured tool_calls format.
// This function detects that pattern and promotes it to a real tool call.
function extractToolCallsFromContent(content) {
  if (!content || typeof content !== 'string') return [];
  const trimmed = content.trim();
  // Must start with { and look like a tool call JSON object
  if (!trimmed.startsWith('{')) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const name = parsed.name || parsed.function?.name;
    const args = parsed.arguments || parsed.function?.arguments || {};
    if (name && typeof name === 'string' && ['read_file', 'write_file', 'list_directory', 'run_command'].includes(name)) {
      return [{ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }];
    }
  } catch {
    // Content might use backticks or other non-strict-JSON; try a lenient regex extraction
    const nameMatch = trimmed.match(/"name"\s*:\s*"(read_file|write_file|list_directory|run_command)"/);
    if (!nameMatch) return [];
    const argsMatch = trimmed.match(/"arguments"\s*:\s*(\{[\s\S]*\})/);
    if (!argsMatch) return [{ function: { name: nameMatch[1], arguments: '{}' } }];
    // Try to parse just the arguments block, cleaning common issues
    try {
      const cleaned = argsMatch[1].replace(/`/g, '"');
      JSON.parse(cleaned);
      return [{ function: { name: nameMatch[1], arguments: cleaned } }];
    } catch { return [{ function: { name: nameMatch[1], arguments: '{}' } }]; }
  }
  return [];
}

function headers(model) {
  const value = { 'Content-Type': 'application/json; charset=utf-8' };
  if (model.apiKey) value.Authorization = `Bearer ${model.apiKey}`;
  return value;
}

function isToolCapable(model) { return model.type === 'ollama' && model.toolCapable !== false && knownToolFamilies.test(String(model.model || '')); }

async function modelCapability(model) {
  if (model.type !== 'ollama') return { supported: false, source: 'not-ollama' };
  try {
    const response = await request(endpointUrl(model, '/api/show'), { method: 'POST', headers: headers(model), body: JSON.stringify({ name: model.model }) });
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body.capabilities)) return { supported: body.capabilities.includes('tools'), source: 'ollama' };
    }
  } catch (_) { /* capability endpoint is optional across Ollama versions */ }
  return { supported: knownToolFamilies.test(String(model.model || '')), source: 'known-family' };
}

async function testConnection(model) {
  try {
    const url = endpointUrl(model, model.type === 'ollama' ? '/api/tags' : '/v1/models');
    const response = await request(url, { headers: headers(model) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}${response.status === 401 || response.status === 403 ? ' \u2014 check API key' : ''}`);
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
  // Fallback: small models may emit tool calls as JSON text in content.
  if (!toolCalls.length && content.trim()) {
    const extracted = extractToolCallsFromContent(content);
    if (extracted.length) {
      customModelTrace('ollama.content-tool-fallback', { extractedCount: extracted.length, rawContent: content.slice(0, 200) });
      toolCalls = extracted;
    }
  }
  return { content, toolCalls };
}

async function streamOllamaAgent(webContents, paneId, requestId, model, messages, cwd, fullAutoApprove, maxIterations) {
  const history = messages.map(({ role, content }) => ({ role, content }));
  // Inject a system prompt on the first turn if the caller didn't provide one,
  // so small models are guided toward using tool calls instead of narrating.
  if (maxIterations > 1 && !history.some((m) => m.role === 'system')) {
    history.unshift({ role: 'system', content: AGENT_SYSTEM_PROMPT });
  }
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // Existing panes retain their creation-time model only as an ID lookup key.
    // Resolve every outbound request from persisted settings so edits apply immediately.
    const liveModel = resolveLiveModel(model);
    const agentic = isToolCapable(liveModel);
    const url = endpointUrl(liveModel, '/api/chat');
    const requestBody = { model: liveModel.model, messages: history, stream: true, ...(agentic ? { tools: TOOL_SCHEMA } : {}) };
    customModelTrace('ollama.chat.request', { paneId, requestId, iteration, method: 'POST', url, body: requestBody, capturedModel: modelConnection(model), dispatchedModel: modelConnection(liveModel) });
    const response = await request(url, { method: 'POST', headers: headers(liveModel), body: JSON.stringify(requestBody) }, CHAT_TIMEOUT_MS);
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
  const initialLiveModel = resolveLiveModel(model);
  customModelTrace('streamChat.enter', { paneId, requestId, capturedModel: modelConnection(model), initialLiveModel: modelConnection(initialLiveModel), messageCount: Array.isArray(messages) ? messages.length : 0 });
  try {
    const agentic = initialLiveModel.type === 'ollama' && isToolCapable(initialLiveModel);
    // Only tool-enabled Ollama requests need a project root. Plain chat must
    // remain usable before a folder is opened, just like OpenAI-compatible chat.
    if (agentic) {
      const projectCwd = projectRoot.resolveWorkingDirectory(cwd, 'model tool loop');
      projectRoot.assertSpawnCwd(projectCwd, 'custom-model:tool-loop');
      return await streamOllamaAgent(webContents, paneId, requestId, model, messages, projectCwd, fullAutoApprove, Math.min(Math.max(Number(maxIterations) || 25, 1), 100));
    }
    if (initialLiveModel.type === 'ollama') return await streamOllamaAgent(webContents, paneId, requestId, model, messages, cwd, fullAutoApprove, 1);
    // Resolve again immediately before the non-Ollama request for the same live-settings guarantee.
    const liveModel = resolveLiveModel(model);
    const url = endpointUrl(liveModel, '/v1/chat/completions');
    const body = { model: liveModel.model, messages, stream: true };
    customModelTrace('openai.chat.request', { paneId, requestId, method: 'POST', url, body, capturedModel: modelConnection(model), dispatchedModel: modelConnection(liveModel) });
    const response = await request(url, { method: 'POST', headers: headers(liveModel), body: JSON.stringify(body) }, CHAT_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}${response.status === 401 || response.status === 403 ? ' \u2014 check API key' : ''}`);
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
