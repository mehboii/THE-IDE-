const { randomUUID } = require('crypto');

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

function headers(model) {
  const value = { 'Content-Type': 'application/json' };
  if (model.apiKey) value.Authorization = `Bearer ${model.apiKey}`;
  return value;
}

async function testConnection(model) {
  try {
    const url = `${baseUrl(model)}${model.type === 'ollama' ? '/api/tags' : '/v1/models'}`;
    const response = await request(url, { headers: headers(model) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}${response.status === 401 || response.status === 403 ? ' — check API key' : ''}`);
    return { success: true, message: `Connected to ${url}` };
  } catch (error) { return { success: false, error: error.message }; }
}

async function streamChat(webContents, paneId, model, messages) {
  const requestId = randomUUID();
  const url = `${baseUrl(model)}${model.type === 'ollama' ? '/api/chat' : '/v1/chat/completions'}`;
  const body = model.type === 'ollama'
    ? { model: model.model, messages, stream: true }
    : { model: model.model, messages, stream: true };
  try {
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

module.exports = { testConnection, streamChat };
