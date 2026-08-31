class CustomModelPane {
  constructor({ id, label, model, cwd, onFocus, onClose, onRestart, onKill, onCwdChange, onLabelChange, onStatusChange }) {
    Object.assign(this, { id, label: label || model.name, model, cwd: cwd || '', onFocus, onClose, onRestart, onKill, onCwdChange, onLabelChange, onStatusChange });
    this.status = 'idle'; this.messages = []; this._activeMessage = null; this.fullAutoApprove = false; this.toolCards = new Map();
    this._createDOM();
  }
  async init() { this.setStatus('running'); }
  _createDOM() {
    this.container = document.createElement('div'); this.container.className = 'terminal-pane custom-model-pane'; this.container.dataset.paneId = this.id;
    this.container.innerHTML = `<div class="pane-header"><div class="pane-header-left"><span class="status-dot status-idle"></span><input class="pane-label-input" value="${this.escapeHtml(this.label)}" aria-label="Pane label"><button class="custom-cwd" type="button" title="Choose project folder">${this.escapeHtml(this.cwd || 'Project root')}</button><span class="custom-model-badge">${this.escapeHtml(this.model.type === 'ollama' ? 'Ollama' : 'OpenAI API')}</span></div><div class="pane-header-right"><label class="tool-approve-toggle" title="Allow writes and commands without a prompt"><input type="checkbox"> Auto approve</label><button class="pane-action-btn btn-reconnect" type="button">Reconnect</button><button class="pane-action-btn btn-restart-pane" type="button">Restart</button><button class="pane-action-btn btn-kill-pane" type="button">Kill</button><button class="pane-action-btn btn-close-pane" type="button">Close</button></div></div><div class="chat-body"><div class="chat-messages" aria-live="polite"></div><div class="chat-disconnected hidden"><strong>Disconnected</strong><span class="disconnect-detail"></span><button class="btn btn-primary btn-reconnect" type="button">Reconnect</button></div><form class="chat-composer"><textarea placeholder="Message ${this.escapeHtml(this.model.name)}\u2026" rows="2" aria-label="Chat message"></textarea><button class="btn btn-primary" type="submit">Send</button></form></div>`;
    this.statusDot = this.container.querySelector('.status-dot'); this.messagesEl = this.container.querySelector('.chat-messages'); this.composer = this.container.querySelector('.chat-composer'); this.input = this.composer.querySelector('textarea'); this.disconnectedEl = this.container.querySelector('.chat-disconnected');
    this.container.addEventListener('mousedown', () => this.onFocus?.(this.id));
    this.container.querySelector('.pane-label-input').addEventListener('change', (e) => { this.label = e.target.value.trim() || this.label; this.onLabelChange?.(this.id, this.label); });
    this.cwdButton = this.container.querySelector('.custom-cwd');
    this.cwdButton.addEventListener('click', async (e) => { e.stopPropagation(); const cwd = await window.electronAPI.selectDirectory(this.cwd || undefined); if (cwd) { this.cwd = cwd; this.cwdButton.textContent = cwd; this.onCwdChange?.(this.id, cwd); } });
    this.container.querySelector('.tool-approve-toggle input').addEventListener('change', (e) => { this.fullAutoApprove = e.target.checked; });
    this.composer.addEventListener('submit', (e) => { e.preventDefault(); this.send(this.input.value); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(this.input.value); } });
    this.container.querySelectorAll('.btn-reconnect').forEach((b) => b.addEventListener('click', () => this.reconnect()));
    this.container.querySelector('.btn-restart-pane').addEventListener('click', () => this.onRestart?.(this.id));
    this.container.querySelector('.btn-kill-pane').addEventListener('click', () => this.onKill?.(this.id));
    this.container.querySelector('.btn-close-pane').addEventListener('click', () => this.onClose?.(this.id));
  }
  async reconnect() { const result = await window.electronAPI.testCustomModel(this.model); if (result.success) { this.disconnectedEl.classList.add('hidden'); this.setStatus('running'); this.input.disabled = false; this.input.focus(); } else this.disconnect(result.error); }
  async send(text) {
    text = String(text || '').trim(); if (!text || this.status === 'disconnected') return;
    this.addMessage('user', text); this.input.value = ''; this.input.disabled = true; this._activeMessage = this.addMessage('assistant', ''); this.setStatus('busy');
    await window.electronAPI.sendCustomModelChat({ paneId: this.id, model: this.model, cwd: this.cwd, fullAutoApprove: this.fullAutoApprove, maxIterations: this.model.maxIterations || 25, messages: this.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map(({ role, content }) => ({ role, content })) });
  }
  receiveToken(token) { if (this._activeMessage) { this._activeMessage.content += token; this._activeMessage.el.textContent = this._activeMessage.content; this.messagesEl.scrollTop = this.messagesEl.scrollHeight; } }
  receiveDone() { this._activeMessage = null; this.input.disabled = false; this.setStatus('running'); this.input.focus(); }
  disconnect(error) { this._activeMessage = null; this.input.disabled = true; this.disconnectedEl.classList.remove('hidden'); this.disconnectedEl.querySelector('.disconnect-detail').textContent = ` \u2014 ${error}`; this.setStatus('disconnected'); }
  showToolCall(call) {
    const card = document.createElement('details'); card.className = 'tool-call'; card.open = true; card.innerHTML = `<summary>${this.escapeHtml(call.title || call.name)}</summary><pre>${this.escapeHtml(JSON.stringify(call.args || {}, null, 2))}</pre>`;
    if (call.needsApproval) { const actions = document.createElement('div'); actions.className = 'tool-approval'; actions.innerHTML = '<span>Approval required</span><button class="btn btn-primary" type="button">Approve</button><button class="btn btn-danger" type="button">Deny</button>'; actions.querySelector('.btn-primary').addEventListener('click', () => { window.electronAPI.decideCustomModelTool(call.callId, true); actions.remove(); }); actions.querySelector('.btn-danger').addEventListener('click', () => { window.electronAPI.decideCustomModelTool(call.callId, false); actions.remove(); }); card.appendChild(actions); }
    this.messagesEl.appendChild(card); this.toolCards.set(call.callId, card); this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  showToolResult({ callId, result }) { const card = this.toolCards.get(callId); if (!card) return; const resultEl = document.createElement('pre'); resultEl.className = `tool-result ${result.ok ? 'ok' : 'error'}`; resultEl.textContent = result.ok ? JSON.stringify(result, null, 2) : `Error: ${result.error || result.stderr}`; card.appendChild(resultEl); card.open = false; }
  showMaxIterations(maxIterations) { this.addMessage('assistant', `Max tool-call iterations reached (${maxIterations}). Stopped to prevent an infinite loop.`); }
  addMessage(role, content) { const el = document.createElement('div'); el.className = `chat-message ${role}`; el.textContent = content; this.messagesEl.appendChild(el); const item = { role, content, el }; this.messages.push(item); this.messagesEl.scrollTop = this.messagesEl.scrollHeight; return item; }
  setStatus(status) { this.status = status; this.statusDot.className = `status-dot status-${status}`; this.statusDot.title = `Model status: ${status}`; this.onStatusChange?.(this.id, status); }
  setFocused(focused) { this.container.classList.toggle('focused', focused); if (focused && !this.input.disabled) this.input.focus(); }
  fit() {} getDimensions() { return { cols: 80, rows: 24 }; } clearTerminal() { this.messagesEl.innerHTML = ''; this.messages = []; this.toolCards.clear(); } write() {} setCwd(cwd) { this.cwd = cwd || ''; this.cwdButton.textContent = this.cwd || 'Project root'; } destroy() { this.container.remove(); }
  escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
}
window.CustomModelPane = CustomModelPane;
