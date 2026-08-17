class EditorApp {
  constructor() {
    this.manager = new CodeEditorManager(
      document.getElementById('monaco-editor-container'),
      document.getElementById('code-editor-tabs')
    );
    this.rootLabel = document.getElementById('editor-root-label');
    this.rootDirectory = null;
    this.currentRunId = null;

    // DOM Elements
    this.btnSave = document.getElementById('btn-editor-save');
    this.btnRun = document.getElementById('btn-editor-run');
    this.btnRunChevron = document.getElementById('btn-editor-run-chevron');
    this.runDropdownMenu = document.getElementById('run-dropdown-menu');
    this.btnMenuRun = document.getElementById('menu-opt-run');
    this.btnMenuRunNoDebug = document.getElementById('menu-opt-run-no-debug');
    this.btnMenuDebug = document.getElementById('menu-opt-debug');
    this.btnStop = document.getElementById('btn-editor-stop');

    this.runOutputPanel = document.getElementById('run-output-panel');
    this.runOutputTitle = document.getElementById('run-output-title');
    this.runOutputStatus = document.getElementById('run-output-status');
    this.runOutputContent = document.getElementById('run-output-content');
    this.btnClearOutput = document.getElementById('btn-clear-output');
    this.btnCloseOutput = document.getElementById('btn-close-output');

    this.debugToolbarControls = document.getElementById('debug-toolbar-controls');
    this.btnDebugContinue = document.getElementById('btn-debug-continue');
    this.btnDebugStepOver = document.getElementById('btn-debug-step-over');
    this.btnDebugStepInto = document.getElementById('btn-debug-step-into');
    this.btnDebugStepOut = document.getElementById('btn-debug-step-out');
    this.debugVariablesPanel = document.getElementById('debug-variables-panel');
    this.debugVariablesList = document.getElementById('debug-variables-list');

    this.initListeners();
    this.initProjectRoot();
  }

  async initProjectRoot() {
    if (window.electronAPI && window.electronAPI.getProjectRoot) {
      const pr = await window.electronAPI.getProjectRoot();
      if (pr) {
        this.rootDirectory = pr;
        this.rootLabel.textContent = pr;
      }
    }
  }

  initListeners() {
    window.electronAPI.onEditorOpenFile((filePath) => this.openFile(filePath));

    // Save button
    if (this.btnSave) {
      this.btnSave.addEventListener('click', () => this.save());
    }

    // Run buttons & dropdown
    if (this.btnRun) {
      this.btnRun.addEventListener('click', () => this.executeRun('run'));
    }
    if (this.btnRunChevron) {
      this.btnRunChevron.addEventListener('click', (e) => {
        e.stopPropagation();
        this.runDropdownMenu.classList.toggle('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      if (this.runDropdownMenu && !this.runDropdownMenu.contains(e.target) && e.target !== this.btnRunChevron) {
        this.runDropdownMenu.classList.add('hidden');
      }
    });

    if (this.btnMenuRun) {
      this.btnMenuRun.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('run');
      });
    }
    if (this.btnMenuRunNoDebug) {
      this.btnMenuRunNoDebug.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('run-without-debug');
      });
    }
    if (this.btnMenuDebug) {
      this.btnMenuDebug.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('debug');
      });
    }

    if (this.btnStop) {
      this.btnStop.addEventListener('click', () => this.stopCurrentRun());
    }

    if (this.btnClearOutput) {
      this.btnClearOutput.addEventListener('click', () => {
        if (this.runOutputContent) this.runOutputContent.textContent = '';
      });
    }
    if (this.btnCloseOutput) {
      this.btnCloseOutput.addEventListener('click', () => {
        if (this.runOutputPanel) this.runOutputPanel.classList.add('hidden');
      });
    }

    // Keyboard Shortcuts (F5 for Debug, Ctrl+F5 / Cmd+F5 for Run Without Debugging)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.executeRun('run-without-debug');
        } else {
          this.executeRun('debug');
        }
      }
    });

    // Debug Step Control Buttons
    if (this.btnDebugContinue) this.btnDebugContinue.addEventListener('click', () => this.sendDebugCmd('resume'));
    if (this.btnDebugStepOver) this.btnDebugStepOver.addEventListener('click', () => this.sendDebugCmd('stepOver'));
    if (this.btnDebugStepInto) this.btnDebugStepInto.addEventListener('click', () => this.sendDebugCmd('stepInto'));
    if (this.btnDebugStepOut) this.btnDebugStepOut.addEventListener('click', () => this.sendDebugCmd('stepOut'));

    // Runner IPC Listeners
    if (window.electronAPI.onRunnerData) {
      window.electronAPI.onRunnerData(({ runId, text }) => {
        if (runId === this.currentRunId && this.runOutputContent) {
          this.runOutputContent.textContent += text;
          this.runOutputContent.scrollTop = this.runOutputContent.scrollHeight;
        }
      });
    }

    if (window.electronAPI.onRunnerExit) {
      window.electronAPI.onRunnerExit(({ runId, exitCode }) => {
        if (runId === this.currentRunId) {
          this.runOutputStatus.textContent = `[Exited with code ${exitCode}]`;
          this.btnStop.classList.add('hidden');
          this.debugToolbarControls.classList.add('hidden');
          this.debugVariablesPanel.classList.add('hidden');
          this.manager.clearPausedLine();
          this.currentRunId = null;
        }
      });
    }

    if (window.electronAPI.onDebugPaused) {
      window.electronAPI.onDebugPaused(({ runId, lineNumber, variables }) => {
        if (runId === this.currentRunId) {
          this.runOutputStatus.textContent = `[Paused on line ${lineNumber}]`;
          this.debugToolbarControls.classList.remove('hidden');
          this.debugVariablesPanel.classList.remove('hidden');
          if (this.manager.activeFilePath) {
            this.manager.highlightPausedLine(this.manager.activeFilePath, lineNumber);
          }
          this.renderVariables(variables || []);
        }
      });
    }

    if (window.electronAPI.onDebugResumed) {
      window.electronAPI.onDebugResumed(({ runId }) => {
        if (runId === this.currentRunId) {
          this.runOutputStatus.textContent = `[Running…]`;
          this.manager.clearPausedLine();
        }
      });
    }
  }

  async openFile(filePath) {
    await this.manager.openFile(filePath);
    this.rootDirectory = filePath.replace(/[\\/][^\\/]+$/, '');
    this.rootLabel.textContent = this.rootDirectory;
    if (window.electronAPI && window.electronAPI.setProjectRoot) {
      await window.electronAPI.setProjectRoot(this.rootDirectory);
    }
  }

  async openFolder() {
    const folder = await window.electronAPI.selectDirectory(this.rootDirectory || undefined);
    if (folder) {
      this.rootDirectory = folder;
      this.rootLabel.textContent = folder;
      if (window.electronAPI && window.electronAPI.setProjectRoot) {
        await window.electronAPI.setProjectRoot(folder);
      }
    }
  }

  save() { return this.manager.saveActiveFile(); }
  saveAs() { return this.manager.saveAsActiveFile(); }

  async executeRun(mode = 'run') {
    const filePath = this.manager.activeFilePath;
    if (!filePath) {
      if (!window.__IDE_TEST_MODE__) alert('No active file open in the editor.');
      return { success: false, message: 'No active file open in the editor.' };
    }

    const breakpoints = this.manager.getBreakpoints(filePath);
    const result = await window.electronAPI.executeRun({ filePath, mode, breakpoints });

    if (!result.success) {
      if (!window.__IDE_TEST_MODE__) {
        if (result.isNotice) {
          alert(result.message);
        } else {
          alert(`Run Error: ${result.message}`);
        }
      }
      return result;
    }

    if (result.isNotice) {
      return result; // Browser or external launcher
    }

    this.currentRunId = result.runId;
    this.runOutputTitle.textContent = result.label || 'Run Output';
    this.runOutputStatus.textContent = '[Running…]';
    this.runOutputContent.textContent = '';
    this.runOutputPanel.classList.remove('hidden');
    this.btnStop.classList.remove('hidden');
    this.debugToolbarControls.classList.add('hidden');
    this.debugVariablesPanel.classList.add('hidden');
    this.manager.clearPausedLine();
    return result;
  }

  async stopCurrentRun() {
    if (this.currentRunId && window.electronAPI.stopRun) {
      await window.electronAPI.stopRun(this.currentRunId);
      this.runOutputStatus.textContent = '[Stopped]';
      this.btnStop.classList.add('hidden');
      this.debugToolbarControls.classList.add('hidden');
      this.debugVariablesPanel.classList.add('hidden');
      this.manager.clearPausedLine();
      this.currentRunId = null;
    }
  }

  sendDebugCmd(cmd) {
    if (this.currentRunId && window.electronAPI.sendDebugCommand) {
      window.electronAPI.sendDebugCommand(this.currentRunId, cmd);
    }
  }

  renderVariables(vars) {
    if (!this.debugVariablesList) return;
    this.debugVariablesList.innerHTML = '';
    if (!vars || vars.length === 0) {
      this.debugVariablesList.innerHTML = '<div style="color:#888;">No variables</div>';
      return;
    }
    vars.forEach(v => {
      const item = document.createElement('div');
      item.className = 'debug-var-item';
      item.innerHTML = `<span class="debug-var-name">${this.escapeHtml(v.name)}</span><span class="debug-var-val" title="${this.escapeHtml(v.value)}">${this.escapeHtml(v.value)}</span>`;
      this.debugVariablesList.appendChild(item);
    });
  }

  escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.editorApp = new EditorApp();
});
