class CodeEditorManager {
  constructor(containerEl, tabsContainerEl, paneGetterFn) {
    this.containerEl = containerEl;
    this.tabsContainerEl = tabsContainerEl;
    this.getPanesListFn = paneGetterFn; // Function that returns array of active panes
    this.editor = null;
    this.monacoReady = false;
    this.openTabs = new Map(); // filePath -> { filePath, content, mode: 'view'|'edit', linkedPaneId: string|null, model: monaco.editor.ITextModel }
    this.activeFilePath = null;
    this.fileChangeUnsubscribe = null;

    this.initMonaco();
    this.setupFileWatcherListener();
  }

  initMonaco() {
    if (window.monaco) {
      this.onMonacoLoaded();
    } else if (window.require) {
      window.require.config({ paths: { 'vs': '../node_modules/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        this.onMonacoLoaded();
      });
    }
  }

  onMonacoLoaded() {
    if (!this.containerEl) return;
    this.monacoReady = true;

    this.editor = monaco.editor.create(this.containerEl, {
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection'
    });

    // Add Ctrl+S / Cmd+S save command to Monaco
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActiveFile();
    });

    // If a tab was queued before Monaco loaded, show it now
    if (this.activeFilePath && this.openTabs.has(this.activeFilePath)) {
      this.switchTab(this.activeFilePath);
    }
  }

  setupFileWatcherListener() {
    if (window.electronAPI && window.electronAPI.onFileChanged) {
      this.fileChangeUnsubscribe = window.electronAPI.onFileChanged(({ filePath }) => {
        this.handleExternalFileChange(filePath);
      });
    }
  }

  async handleExternalFileChange(filePath) {
    const tabData = this.openTabs.get(filePath);
    if (!tabData) return;

    // Read updated content from disk
    const res = await window.electronAPI.readFile(filePath);
    if (!res.success) return;

    tabData.content = res.content;

    // Auto-refresh in View mode live
    if (tabData.mode === 'view') {
      if (tabData.model) {
        const scrollTop = (this.activeFilePath === filePath && this.editor) ? this.editor.getScrollTop() : 0;
        tabData.model.setValue(res.content);
        if (this.activeFilePath === filePath && this.editor) {
          this.editor.setScrollTop(scrollTop);
        }
      }
      this.showLiveRefreshPulse(filePath);
    }
  }

  showLiveRefreshPulse(filePath) {
    const tabEl = this.tabsContainerEl ? this.tabsContainerEl.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`) : null;
    if (tabEl) {
      tabEl.classList.add('live-refreshed');
      setTimeout(() => tabEl.classList.remove('live-refreshed'), 1000);
    }
  }

  async openFile(filePath, mode = 'view', linkedPaneId = null) {
    if (this.openTabs.has(filePath)) {
      this.switchTab(filePath);
      return;
    }

    const res = await window.electronAPI.readFile(filePath);
    if (!res.success) {
      console.error(`Failed to read file ${filePath}:`, res.error);
      return;
    }

    // Watch file on disk
    if (window.electronAPI && window.electronAPI.watchFile) {
      window.electronAPI.watchFile(filePath);
    }

    const language = this.detectLanguage(filePath);
    let model = null;
    if (this.monacoReady && window.monaco) {
      model = monaco.editor.createModel(res.content, language, monaco.Uri.file(filePath));
    }

    const tabData = {
      filePath,
      name: filePath.split(/[/\\]/).pop(),
      content: res.content,
      mode,
      linkedPaneId,
      model,
      language
    };

    this.openTabs.set(filePath, tabData);
    this.renderTabs();
    this.switchTab(filePath);
  }

  switchTab(filePath) {
    const tabData = this.openTabs.get(filePath);
    if (!tabData) return;

    this.activeFilePath = filePath;
    this.renderTabs();

    if (this.editor && this.monacoReady) {
      if (!tabData.model && window.monaco) {
        tabData.model = monaco.editor.createModel(tabData.content, tabData.language, monaco.Uri.file(filePath));
      }
      if (tabData.model) {
        this.editor.setModel(tabData.model);
        this.editor.updateOptions({ readOnly: tabData.mode === 'view' });
      }
    }
  }

  closeTab(filePath) {
    const tabData = this.openTabs.get(filePath);
    if (tabData) {
      if (tabData.model) {
        tabData.model.dispose();
      }
      if (window.electronAPI && window.electronAPI.unwatchFile) {
        window.electronAPI.unwatchFile(filePath);
      }
      this.openTabs.delete(filePath);
    }

    if (this.activeFilePath === filePath) {
      const keys = Array.from(this.openTabs.keys());
      this.activeFilePath = keys.length > 0 ? keys[keys.length - 1] : null;
      if (this.activeFilePath) {
        this.switchTab(this.activeFilePath);
      } else if (this.editor) {
        this.editor.setModel(null);
      }
    }

    this.renderTabs();
  }

  toggleMode(filePath) {
    const tabData = this.openTabs.get(filePath);
    if (!tabData) return;

    tabData.mode = tabData.mode === 'view' ? 'edit' : 'view';
    if (this.activeFilePath === filePath && this.editor) {
      this.editor.updateOptions({ readOnly: tabData.mode === 'view' });
    }
    this.renderTabs();
  }

  setLinkedPane(filePath, paneId) {
    const tabData = this.openTabs.get(filePath);
    if (!tabData) return;

    tabData.linkedPaneId = paneId || null;
    this.renderTabs();
  }

  async saveActiveFile() {
    if (!this.activeFilePath) return;
    const tabData = this.openTabs.get(this.activeFilePath);
    if (!tabData || tabData.mode !== 'edit') return;

    const currentContent = tabData.model ? tabData.model.getValue() : tabData.content;
    const res = await window.electronAPI.writeFile(this.activeFilePath, currentContent);
    if (res.success) {
      tabData.content = currentContent;
      this.showSaveSuccessIndicator(this.activeFilePath);
    } else {
      alert(`Failed to save file: ${res.error}`);
    }
  }

  showSaveSuccessIndicator(filePath) {
    const tabEl = this.tabsContainerEl ? this.tabsContainerEl.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`) : null;
    if (tabEl) {
      tabEl.classList.add('saved-success');
      setTimeout(() => tabEl.classList.remove('saved-success'), 1200);
    }
  }

  renderTabs() {
    if (!this.tabsContainerEl) return;
    this.tabsContainerEl.innerHTML = '';

    if (this.openTabs.size === 0) {
      this.tabsContainerEl.innerHTML = '<div class="editor-tabs-empty">No files open</div>';
      return;
    }

    const panes = this.getPanesListFn ? this.getPanesListFn() : [];

    for (const [filePath, tabData] of this.openTabs.entries()) {
      const isActive = filePath === this.activeFilePath;
      const tabEl = document.createElement('div');
      tabEl.className = `editor-tab ${isActive ? 'active' : ''}`;
      tabEl.setAttribute('data-filepath', filePath);

      // Find linked pane info
      const linkedPane = panes.find(p => p.id === tabData.linkedPaneId);
      const dotColor = linkedPane ? (linkedPane.status === 'exited' ? '#f43f5e' : '#10b981') : 'transparent';

      tabEl.innerHTML = `
        <span class="editor-tab-title" title="${filePath}">${tabData.name}</span>
        
        <!-- Mode toggle pill -->
        <button class="mode-toggle-pill ${tabData.mode}" type="button" title="Click to toggle View/Edit mode">
          ${tabData.mode === 'view' ? '👁 View' : '✏️ Edit'}
        </button>

        <!-- Pane tracking dropdown -->
        <div class="pane-link-wrapper" title="Link tab to terminal pane">
          <span class="pane-dot" style="background-color: ${dotColor}; display: ${linkedPane ? 'inline-block' : 'none'}"></span>
          <select class="pane-link-select">
            <option value="">Watching: None</option>
            ${panes.map(p => `<option value="${p.id}" ${p.id === tabData.linkedPaneId ? 'selected' : ''}>Watching: ${p.title || p.id}</option>`).join('')}
          </select>
        </div>

        <button class="editor-tab-close" type="button" title="Close tab">×</button>
      `;

      // Event listeners
      tabEl.addEventListener('click', (e) => {
        if (!e.target.closest('.mode-toggle-pill') && !e.target.closest('.pane-link-select') && !e.target.closest('.editor-tab-close')) {
          this.switchTab(filePath);
        }
      });

      const modeBtn = tabEl.querySelector('.mode-toggle-pill');
      modeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMode(filePath);
      });

      const selectEl = tabEl.querySelector('.pane-link-select');
      selectEl.addEventListener('change', (e) => {
        e.stopPropagation();
        this.setLinkedPane(filePath, e.target.value);
      });

      const closeBtn = tabEl.querySelector('.editor-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(filePath);
      });

      this.tabsContainerEl.appendChild(tabEl);
    }
  }

  detectLanguage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    switch (ext) {
      case 'js': case 'jsx': case 'mjs': return 'javascript';
      case 'ts': case 'tsx': return 'typescript';
      case 'py': case 'pyw': return 'python';
      case 'json': return 'json';
      case 'md': return 'markdown';
      case 'html': case 'htm': return 'html';
      case 'css': return 'css';
      case 'sh': case 'bash': case 'zsh': return 'shell';
      case 'xml': return 'xml';
      case 'yaml': case 'yml': return 'yaml';
      case 'c': case 'h': case 'cpp': case 'hpp': return 'cpp';
      case 'java': return 'java';
      default: return 'plaintext';
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CodeEditorManager;
}
