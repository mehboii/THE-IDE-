class TerminalPane {
  constructor({ id, label, cwd, agentId, agentCommand, customModelId, envVars = {}, onFocus, onClose, onRestart, onKill, onCwdChange, onAgentChange, onLabelChange, onStatusChange }) {
    this.id = id;
    this.label = label || `Pane ${id}`;
    this.cwd = cwd || '';
    this.agentId = agentId || 'shell';
    this.agentCommand = agentCommand;
    this.customModelId = customModelId || null;
    this.envVars = { ...envVars };
    this.status = 'idle'; // running | idle | exited | detached

    this.onFocus = onFocus;
    this.onClose = onClose;
    this.onRestart = onRestart;
    this.onKill = onKill;
    this.onCwdChange = onCwdChange;
    this.onAgentChange = onAgentChange;
    this.onLabelChange = onLabelChange;
    this.onStatusChange = onStatusChange;

    this.container = null;
    this.terminal = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.availableAgents = [];
    this.isFocused = false;
    this._createDOM();
  }

  async init(agentsList) {
    this.availableAgents = agentsList || [];
    this.populateAgentsDropdown();
    this.initXterm();
  }

  _createDOM() {
    this.container = document.createElement('div');
    this.container.className = 'terminal-pane';
    this.container.dataset.paneId = this.id;
    this.container.setAttribute('role', 'group');
    this.container.setAttribute('aria-label', this.label);

    this.container.innerHTML = `
      <div class="pane-header">
        <div class="pane-header-left">
          <span class="status-dot status-idle" title="Session Status: Idle" data-testid="status-dot"></span>
          <input type="text" class="pane-label-input" value="${this.escapeHtml(this.label)}" title="Click to rename pane" aria-label="Pane label" />
          <div class="cwd-badge" title="${this.escapeHtml(this.cwd || 'No working directory selected')}">
            <span class="cwd-text" title="${this.escapeHtml(this.cwd || 'No working directory selected')}">${this.escapeHtml(this.cwd || '~')}</span>
            <button class="btn-folder-pick" type="button" title="Change working directory" aria-label="Pick folder">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
            </button>
          </div>
        </div>
        <div class="pane-header-right">
          <select class="select-input agent-select" title="Select CLI agent preset" aria-label="Agent preset"></select>
          <button class="pane-action-btn btn-run-agent" type="button" title="Run CLI agent preset">Run Agent</button>
          <button class="pane-action-btn btn-restart-pane" type="button" title="Restart terminal session">Restart</button>
          <button class="pane-action-btn btn-kill-pane" type="button" title="Kill session">Kill</button>
          <button class="pane-action-btn btn-close-pane" type="button" title="Close pane (detach)">Close</button>
        </div>
      </div>
      <div class="xterm-wrapper"></div>
    `;

    this.statusDot = this.container.querySelector('.status-dot');
    this.labelInput = this.container.querySelector('.pane-label-input');
    this.cwdText = this.container.querySelector('.cwd-text');
    this.folderBtn = this.container.querySelector('.btn-folder-pick');
    this.agentSelect = this.container.querySelector('.agent-select');
    this.runAgentBtn = this.container.querySelector('.btn-run-agent');
    this.restartBtn = this.container.querySelector('.btn-restart-pane');
    this.killBtn = this.container.querySelector('.btn-kill-pane');
    this.closeBtn = this.container.querySelector('.btn-close-pane');
    this.xtermWrapper = this.container.querySelector('.xterm-wrapper');

    const focusTerminal = () => {
      if (this.onFocus) this.onFocus(this.id);
      if (this.terminal) {
        this.terminal.focus();
        if (this.terminal.textarea) {
          try { this.terminal.textarea.focus(); } catch (_) {}
        }
      }
    };

    this.container.addEventListener('mousedown', focusTerminal);
    this.container.addEventListener('click', focusTerminal);

    this.labelInput.addEventListener('change', () => {
      this.label = this.labelInput.value.trim() || this.label;
      this.labelInput.value = this.label;
      if (this.onLabelChange) this.onLabelChange(this.id, this.label);
    });
    this.labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.labelInput.blur();
      }
      e.stopPropagation();
    });
    this.labelInput.addEventListener('click', (e) => e.stopPropagation());

    this.folderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const newDir = await window.electronAPI.selectDirectory(this.cwd || undefined);
        if (newDir) {
          this.cwd = newDir;
          this.cwdText.textContent = newDir;
          if (this.onCwdChange) this.onCwdChange(this.id, newDir);
        }
      } catch (err) {
        console.error('[Pane] folder pick failed:', err);
      }
    });

    this.agentSelect.addEventListener('change', () => {
      this.agentId = this.agentSelect.value;
      if (this.onAgentChange) this.onAgentChange(this.id, this.agentId);
      if (window.appInstance && window.appInstance.openRunAgentModal) {
        window.appInstance.openRunAgentModal({ targetPaneId: this.id, selectedAgentId: this.agentId });
      }
    });
    this.agentSelect.addEventListener('click', (e) => e.stopPropagation());

    if (this.runAgentBtn) {
      this.runAgentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.appInstance && window.appInstance.openRunAgentModal) {
          window.appInstance.openRunAgentModal({ targetPaneId: this.id, selectedAgentId: this.agentId });
        }
      });
    }

    this.restartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onRestart) this.onRestart(this.id);
    });
    this.killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onKill) this.onKill(this.id);
    });
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onClose) this.onClose(this.id);
    });
  }

  populateAgentsDropdown() {
    this.agentSelect.innerHTML = '';
    this.availableAgents.forEach((agent) => {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agent.name;
      if (agent.id === this.agentId) opt.selected = true;
      this.agentSelect.appendChild(opt);
    });
  }

  initXterm() {
    const TerminalClass = window.Terminal;
    const FitAddonClass = window.FitAddon ? window.FitAddon.FitAddon : null;
    const SearchAddonClass = window.SearchAddon ? window.SearchAddon.SearchAddon : null;

    this.terminal = new TerminalClass({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#0D0D15',
        foreground: '#FFF7F0',
        cursor: '#FF6B32',
        cursorAccent: '#0D0D15',
        selectionBackground: '#3A1711',
        selectionForeground: '#FFF7F0',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5'
      },
      allowProposedApi: true
    });

    if (FitAddonClass) {
      this.fitAddon = new FitAddonClass();
      this.terminal.loadAddon(this.fitAddon);
    }
    if (SearchAddonClass) {
      this.searchAddon = new SearchAddonClass();
      this.terminal.loadAddon(this.searchAddon);
    }

    this.terminal.open(this.xtermWrapper);

    this.terminal.onData((data) => {
      window.electronAPI.writePty(this.id, data);
      if (window.broadcastManager) {
        window.broadcastManager.handleKeystroke(this.id, data, window.appInstance.panes);
      }
    });

    // Listen for focus on the xterm textarea (created by terminal.open)
    if (this.terminal.textarea) {
      this.terminal.textarea.addEventListener('focus', () => {
        if (this.onFocus) this.onFocus(this.id);
      });
      this.terminal.textarea.addEventListener('keydown', async (event) => {
        const primary = event.metaKey || event.ctrlKey;
        if (!primary || event.altKey) return;
        if (event.key.toLowerCase() === 'c' && this.terminal.hasSelection()) {
          event.preventDefault();
          await window.electronAPI.writeClipboardText(this.terminal.getSelection());
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault();
          const text = await window.electronAPI.readClipboardText();
          if (!text) return;
          window.electronAPI.writePty(this.id, text);
          if (window.broadcastManager) window.broadcastManager.handleKeystroke(this.id, text, window.appInstance.panes);
        }
      });
    }

    // Debounced fit after open
    requestAnimationFrame(() => this.fit());

    // ResizeObserver on the wrapper ensures reflow on any layout change
    // (sidebar collapse, window resize, grid divider drag)
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._resizeTimer) cancelAnimationFrame(this._resizeTimer);
        this._resizeTimer = requestAnimationFrame(() => {
          this._resizeTimer = null;
          this.fit();
        });
      });
      this._resizeObserver.observe(this.xtermWrapper);
    }
  }

  write(data) {
    if (this.terminal) this.terminal.write(data);
  }

  fit() {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      const cols = this.terminal.cols;
      const rows = this.terminal.rows;
      if (cols > 1 && rows > 1) {
        window.electronAPI.resizePty(this.id, cols, rows);
      }
    } catch (err) {
      console.warn(`[Pane ${this.id}] Fit error:`, err);
    }
  }

  setStatus(status) {
    this.status = status;
    this.statusDot.className = `status-dot status-${status}`;
    this.statusDot.title = `Session Status: ${String(status).toUpperCase()}`;
    if (this.onStatusChange) this.onStatusChange(this.id, status);
  }

  setFocused(focused) {
    this.isFocused = focused;
    if (focused) {
      this.container.classList.add('focused');
      if (this.terminal) this.terminal.focus();
    } else {
      this.container.classList.remove('focused');
    }
  }

  setCwd(cwd) {
    this.cwd = cwd || '';
    this.cwdText.textContent = this.cwd || '~';
    const title = this.cwd || 'No working directory selected';
    this.cwdText.title = title;
    const badge = this.cwdText.closest('.cwd-badge');
    if (badge) badge.title = title;
  }

  getDimensions() {
    return {
      cols: this.terminal ? this.terminal.cols : 80,
      rows: this.terminal ? this.terminal.rows : 24
    };
  }

  clearTerminal() {
    if (this.terminal) this.terminal.clear();
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this.terminal) {
      try { this.terminal.dispose(); } catch (_) {}
      this.terminal = null;
    }
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.TerminalPane = TerminalPane;
