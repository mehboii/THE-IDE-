class AppController {
  constructor() {
    this.gridManager = null;
    this.panes = new Map();
    this.agentsList = [];
    this.customModels = [];
    this.workspaces = {};
    this.activeWorkspaceName = null;
    this.focusedPaneId = null;
    this.paneIdCounter = 1;
    this._pendingCreates = 0; // anti-spam: counts in-flight pane creates
    this.customModelTerminalCreates = new Map(); // prevents duplicate model-terminal launches
    this.sidebarCollapsed = false;
    this.sidebarWidth = 260;
    this.commandPaletteIndex = 0;
    this.commandPaletteFiltered = [];

    // DOM refs
    this.gridContainer = document.getElementById('grid-container');
    this.workspaceSelect = document.getElementById('workspace-select');
    this.btnSaveWorkspace = document.getElementById('btn-save-workspace');
    this.btnDeleteWorkspace = document.getElementById('btn-delete-workspace');
    this.btnPreset2x3 = document.getElementById('btn-preset-2x3');
    this.btnPreset3x2 = document.getElementById('btn-preset-3x2');
    this.btnAddPane = document.getElementById('btn-add-pane');
    this.btnToggleBroadcast = document.getElementById('btn-toggle-broadcast');
    this.btnKillAll = document.getElementById('btn-kill-all');
    this.btnHelp = document.getElementById('btn-help');
    this.btnTabAdd = document.getElementById('btn-tab-add');
    this.btnTabClose = document.getElementById('btn-tab-close');
    this.tmuxStatusBadge = document.getElementById('tmux-status-badge');
    this.notificationBanner = document.getElementById('notification-banner');
    this.bannerMessage = document.getElementById('banner-message');
    this.bannerClose = document.getElementById('banner-close');
    this.panesCountEl = document.getElementById('active-panes-count');
    this.sidebarPaneCountEl = document.getElementById('sidebar-pane-count');
    this.focusedPaneInfo = document.getElementById('focused-pane-info');
    this.statusWorkspace = document.getElementById('status-workspace');
    this.statusBar = document.getElementById('status-bar');
    this.sideBar = document.getElementById('side-bar');
    this.sideBarBody = document.getElementById('side-bar-body');
    this.sidebarSessionsList = document.getElementById('sidebar-sessions-list');
    this.sidebarWorkspacesList = document.getElementById('sidebar-workspaces-list');
    this.sidebarAgentsList = document.getElementById('sidebar-agents-list');
    this.sidebarCustomModelsList = document.getElementById('sidebar-custom-models-list');
    this.sidebarCustomModelCount = document.getElementById('sidebar-custom-model-count');
    this.btnAddCustomModel = document.getElementById('btn-add-custom-model');
    this.modalCustomModel = document.getElementById('modal-custom-model');
    this.customModelForm = document.getElementById('custom-model-form');
    this.customModelTestResult = document.getElementById('custom-model-test-result');
    this._editingCustomModelId = null;
    this.editorTabsScroll = document.getElementById('editor-tabs-scroll');
    this.titlebarTitle = document.getElementById('titlebar-title');
    this.appShell = document.getElementById('app-shell');

    this.modalOrphans = document.getElementById('modal-orphans');
    this.orphansList = document.getElementById('orphans-list');
    this.btnOrphansReattachAll = document.getElementById('btn-orphans-reattach-all');
    this.btnOrphansKillAll = document.getElementById('btn-orphans-kill-all');
    this.modalOrphansClose = document.getElementById('modal-orphans-close');
    this.modalHelp = document.getElementById('modal-help');
    this.modalHelpClose = document.getElementById('modal-help-close');
    this.modalHelpOk = document.getElementById('modal-help-ok');

    this.modalRunAgent = document.getElementById('modal-run-agent');
    this.modalRunAgentClose = document.getElementById('modal-run-agent-close');
    this.runAgentSelect = document.getElementById('run-agent-select');
    this.runAgentDesc = document.getElementById('run-agent-desc');
    this.btnRunAgentCancel = document.getElementById('btn-run-agent-cancel');
    this.btnRunAgentSingle = document.getElementById('btn-run-agent-single');
    this.btnRunAgentAll = document.getElementById('btn-run-agent-all');
    this._runAgentTargetPaneId = null;

    this.commandPalette = document.getElementById('command-palette');
    this.commandPaletteInput = document.getElementById('command-palette-input');
    this.commandPaletteList = document.getElementById('command-palette-list');
    this.menubarDropdown = document.getElementById('menubar-dropdown');

    this.fileExplorer = null;
  }

  async init() {
    this.gridManager = new GridManager(this.gridContainer);
    window.broadcastManager.init(this.btnToggleBroadcast);
    window.broadcastManager.onToggle(() => this.updateFooter());

    this.setupIpcListeners();
    await this.checkTmux();

    this.agentsList = await window.electronAPI.getAgents();
    this.customModels = await window.electronAPI.getCustomModels();
    await this.loadWorkspaceOptions();
    this.renderSidebarAgents();
    this.renderCustomModels();

    this.attachEventListeners();
    this.setupKeyboardShortcuts();
    this.setupSidebarResize();
    this.setupCommandPalette();
    this.setupMenubar();

    // The terminal window owns only the file tree. Monaco belongs exclusively
    // to the separate editor BrowserWindow opened through main-process IPC.
    this.fileExplorer = new FileExplorer(
      document.getElementById('sidebar-file-tree'),
      document.getElementById('btn-sidebar-open-folder')
    );
    this.fileExplorer.onFileSelect((filePath) => {
      window.electronAPI.openEditorFile(filePath);
    });
    this.fileExplorer.onRootChange(async (dirPath) => {
      // This assignment is the renderer-to-main handoff for the one true
      // execution root. Awaiting it prevents a pane launch from racing Open
      // Folder and using an earlier pane-local/default cwd.
      const canonicalRoot = await window.electronAPI.setProjectRoot(dirPath);
      console.info('[OPENED FOLDER] Renderer confirmed project root:', canonicalRoot);
      return canonicalRoot;
    });

    // Restore the explorer as a view of the authoritative main-process root.
    const projectRoot = await window.electronAPI.getProjectRoot();
    if (projectRoot) await this.fileExplorer.setRootDirectory(projectRoot);

    const orphans = await window.electronAPI.listOrphans();
    if (orphans && orphans.length > 0 && !window.__IDE_TEST_MODE__) {
      this.showOrphanModal(orphans);
    } else {
      await this.spawnDefaultPanes(4);
    }

    // Deliberately leave the explorer empty until the user explicitly chooses
    // Open Folder. Terminal working directories must not populate it implicitly.
    await this.fileExplorer.render();

    this.updateFooter();
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  setupIpcListeners() {
    window.electronAPI.onPtyData(({ paneId, data }) => {
      const pane = this.panes.get(paneId);
      if (pane) pane.write(data);
    });

    window.electronAPI.onPtyExit(({ paneId, exitCode, status }) => {
      const pane = this.panes.get(paneId);
      if (pane) {
        const next = status === 'detached' ? 'detached' : 'exited';
        pane.setStatus(next);
        this.showBanner(
          `Session for "${pane.label}" ended (code ${exitCode ?? '?'}). tmux may have been killed externally \u2014 use Restart to recover.`,
          'error'
        );
        this.renderEditorTabs();
        this.renderSidebarSessions();
      }
    });
    window.electronAPI.onCwdWarning(({ action, error, cwd, openedFolder }) => {
      this.showBanner(`Working-directory safety check blocked ${action}: ${error} Requested: ${cwd || '(none)'}; opened folder: ${openedFolder || '(none)'}.`, 'error');
    });
    window.electronAPI.onProjectRootChanged(({ root }) => {
      // Includes File > Open Folder initiated by the detached editor window.
      // Queue rather than overlap restarts when users switch folders quickly.
      this._rootSync = (this._rootSync || Promise.resolve())
        .then(() => this.syncPanesToOpenedFolder(root))
        .catch((error) => this.showBanner(`Could not apply opened folder to terminals: ${error.message}`, 'error'));
    });
    window.electronAPI.onCustomModelToken(({ paneId, token }) => this.panes.get(paneId)?.receiveToken?.(token));
    window.electronAPI.onCustomModelDone(({ paneId }) => this.panes.get(paneId)?.receiveDone?.());
    window.electronAPI.onCustomModelError(({ paneId, error }) => this.panes.get(paneId)?.disconnect?.(error));
    window.electronAPI.onCustomModelToolCall((data) => this.panes.get(data.paneId)?.showToolCall?.(data));
    window.electronAPI.onCustomModelToolResult((data) => this.panes.get(data.paneId)?.showToolResult?.(data));
    window.electronAPI.onCustomModelMaxIterations((data) => this.panes.get(data.paneId)?.showMaxIterations?.(data.maxIterations));
  }

  async checkTmux() {
    const status = await window.electronAPI.checkTmux();
    if (status.available) {
      this.tmuxStatusBadge.textContent = status.version ? `tmux ${status.version.replace(/^tmux\s+/i, '')}` : 'tmux active';
      this.tmuxStatusBadge.className = 'badge badge-success';
      if (this.statusBar) this.statusBar.classList.remove('tmux-missing');
    } else {
      this.tmuxStatusBadge.textContent = 'tmux missing (fallback)';
      this.tmuxStatusBadge.className = 'badge badge-danger';
      if (this.statusBar) this.statusBar.classList.add('tmux-missing');
      this.showBanner(
        'tmux not found \u2014 install it to enable session persistence across restarts: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux). Continuing without persistence for now.',
        'warning'
      );
    }
    return status;
  }

  showBanner(msg, kind = 'warning') {
    this.bannerMessage.textContent = msg;
    this.notificationBanner.className = `banner banner-${kind === 'error' ? 'error' : 'warning'}`;
    this.notificationBanner.classList.remove('hidden');
  }

  hideBanner() {
    this.notificationBanner.classList.add('hidden');
  }

  /** Effective pane count including in-flight creates (anti-spam). */
  effectivePaneCount() {
    return this.panes.size + this._pendingCreates;
  }

  async createPane({ id, label, cwd, agentId, agentCommand, customSessionName, customModel, customModelId, envVars = {}, forceNew, trigger = 'new-pane' } = {}) {
    if (this.effectivePaneCount() >= 6) {
      this.showBanner('Maximum 6 terminal panes supported simultaneously.');
      return null;
    }

    this._pendingCreates += 1;
    const paneId = id || `pane-${this.paneIdCounter++}`;

    try {
      // Prevent duplicate IDs
      if (this.panes.has(paneId)) {
        this.showBanner(`Pane "${paneId}" already exists.`);
        return this.panes.get(paneId);
      }

      if (customModel) return this.createCustomModelPane({ id: paneId, label, customModel, cwd });
      const agentObj = this.agentsList.find((a) => a.id === agentId) || this.agentsList.find((a) => a.id === 'shell') || this.agentsList[0];
      // An open Explorer folder is authoritative for every new process. Until
      // one is opened, the main process starts the terminal in the user's home
      // directory; never use a persisted pane or workspace cwd as a fallback.
      const initialCwd = await window.electronAPI.getProjectRoot();

      const pane = new TerminalPane({
        id: paneId,
        label: label || `Pane ${this.panes.size + 1}`,
        cwd: initialCwd,
        agentId: agentId || (agentObj && agentObj.id) || 'shell',
        agentCommand,
        customModelId,
        envVars,
        onFocus: (pId) => this.focusPane(pId),
        onClose: (pId) => this.removePane(pId),
        onRestart: (pId) => this.restartPane(pId, { killTmux: true }),
        onKill: (pId) => this.killPaneSession(pId),
        onCwdChange: (pId, newCwd) => this.changePaneCwd(pId, newCwd),
        onAgentChange: (pId, newAgentId) => this.changePaneAgent(pId, newAgentId),
        onLabelChange: () => {
          this.renderEditorTabs();
          this.renderSidebarSessions();
          this.updateFooter();
        },
        onStatusChange: () => {
          this.renderEditorTabs();
          this.renderSidebarSessions();
        }
      });

      await pane.init(this.agentsList);
      this.panes.set(paneId, pane);
      this.gridManager.addPaneToGrid(pane);

      const dims = pane.getDimensions();
      let result;
      try {
        result = await window.electronAPI.createPty({
          paneId,
          cwd: initialCwd,
          agentCommand: agentCommand !== undefined ? agentCommand : (agentObj ? agentObj.command : ''),
          envVars: { ...(agentObj ? (agentObj.env || {}) : {}), ...envVars },
          customSessionName,
          // IPC structured cloning may omit undefined object properties.
          // Send an explicit value so ordinary panes cannot reattach to a
          // fixed-name tmux session from an earlier launch.
          forceNew: forceNew !== false,
          trigger,
          cols: dims.cols,
          rows: dims.rows
        });
      } catch (error) {
        pane.setStatus('exited');
        this.showBanner(`Unable to start ${pane.label}: ${error.message}`, 'error');
        this.renderEditorTabs();
        this.renderSidebarSessions();
        this.updateFooter();
        return pane;
      }

      if (result && result.cwd) {
        pane.setCwd(result.cwd);
      }

      pane.setStatus('running');
      this.focusPane(paneId);
      this.updateFooter();
      this.renderEditorTabs();
      this.renderSidebarSessions();
      return pane;
    } finally {
      this._pendingCreates = Math.max(0, this._pendingCreates - 1);
    }
  }

  async createCustomModelPane({ id, label, customModel, cwd }) {
    // An open Explorer folder is authoritative for every new chat/tool pane.
    // A chat pane may be displayed before a project is opened, but it must not
    // inherit a stale saved pane cwd. Tool execution re-resolves ProjectRoot in
    // the main process immediately before it runs.
    const initialCwd = await window.electronAPI.getProjectRoot() || '';
    const pane = new CustomModelPane({ id, label: label || customModel.name, model: customModel, cwd: initialCwd,
      onFocus: (pId) => this.focusPane(pId), onClose: (pId) => this.removePane(pId),
      onRestart: (pId) => this.restartPane(pId), onKill: (pId) => this.killPaneSession(pId),
      onCwdChange: (pId, newCwd) => this.changePaneCwd(pId, newCwd),
      onLabelChange: () => { this.renderEditorTabs(); this.renderSidebarSessions(); },
      onStatusChange: () => { this.renderEditorTabs(); this.renderSidebarSessions(); } });
    await pane.init(); this.panes.set(id, pane); this.gridManager.addPaneToGrid(pane); this.focusPane(id);
    this.updateFooter(); this.renderEditorTabs(); this.renderSidebarSessions(); return pane;
  }

  async removePane(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Guard: remove from map first to prevent double-calls on rapid clicks
    this.panes.delete(paneId);

    // A remote chat has no PTY; terminal panes preserve existing detach behavior.
    try {
      if (!(pane instanceof CustomModelPane)) await window.electronAPI.destroyPty(paneId, false);
    } catch (err) {
      console.warn('destroyPty failed', err);
    }
    this.gridManager.removePaneFromGrid(paneId);

    if (this.focusedPaneId === paneId) {
      this.focusedPaneId = null;
      const remaining = Array.from(this.panes.keys());
      if (remaining.length > 0) this.focusPane(remaining[0]);
    }

    this.updateFooter();
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  /**
   * Restart pane. When killTmux is true (default for UI Restart), kill the old
   * tmux session first so -A does not reattach to a dead/stale session.
   */
  async restartPane(paneId, { killTmux = true, trigger = 'pane-restart' } = {}) {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    if (pane instanceof CustomModelPane) { pane.clearTerminal(); await pane.reconnect(); return; }
    const agentObj = this.agentsList.find((a) => a.id === pane.agentId);
    const dims = pane.getDimensions();

    pane.setStatus('idle');
    pane.clearTerminal();
    try {
      if (killTmux) {
        await window.electronAPI.destroyPty(paneId, true);
      }
      // Read the live main-process state at the instant of spawning. Pane.cwd
      // is presentation state only and is never allowed to select a process
      // working directory.
      const liveRoot = await window.electronAPI.getProjectRoot();
      // A missing project root is valid for ordinary terminal shells: the
      // main process chooses the safe home-directory fallback in that case.
      if (liveRoot) pane.setCwd(liveRoot);
      const result = await window.electronAPI.restartPty({
        paneId,
        cwd: liveRoot,
        agentCommand: pane.agentCommand !== undefined ? pane.agentCommand : (agentObj ? agentObj.command : ''),
        envVars: { ...(agentObj ? (agentObj.env || {}) : {}), ...(pane.envVars || {}) },
        trigger,
        cols: dims.cols,
        rows: dims.rows
      });
      if (result?.cwd) pane.setCwd(result.cwd);
      pane.setStatus('running');
      // Refit after restart so PTY gets correct size
      requestAnimationFrame(() => pane.fit());
    } catch (error) {
      pane.setStatus('exited');
      this.showBanner(`Unable to restart ${pane.label}: ${error.message}`, 'error');
    }
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  async killPaneSession(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Skip confirm in test mode
    const ok = window.__IDE_TEST_MODE__ || confirm(`Kill persistent tmux session for ${pane.label}?`);
    if (!ok) return;

    if (pane instanceof CustomModelPane) { pane.disconnect('Stopped by user. Use Reconnect to continue.'); return; }
    try {
      await window.electronAPI.destroyPty(paneId, true);
      pane.setStatus('exited');
      pane.write('\r\n\x1b[31m[session killed]\x1b[0m\r\n');
    } catch (error) {
      this.showBanner(`Failed to kill session: ${error.message}`, 'error');
    }
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  async changePaneCwd(paneId, newCwd) {
    // The pane folder picker changes the shared opened folder; it does not
    // introduce a second, hidden execution root for one pane.
    if (newCwd && this.fileExplorer) {
      await this.fileExplorer.setRootDirectory(newCwd, true);
      return;
    }
    await this.restartPane(paneId, { killTmux: true, trigger: 'pane-folder-change' });
  }

  async changePaneAgent(paneId, newAgentId) {
    const pane = this.panes.get(paneId);
    if (pane) { pane.agentId = newAgentId; pane.agentCommand = undefined; }
    await this.restartPane(paneId, { killTmux: true, trigger: 'agent-preset-change' });
  }

  focusPane(paneId) {
    if (!this.panes.has(paneId)) return;
    this.focusedPaneId = paneId;
    for (const [id, pane] of this.panes.entries()) {
      pane.setFocused(id === paneId);
    }
    this.updateFooter();
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  async spawnDefaultPanes(count = 4) {
    for (let i = 1; i <= count; i++) {
      await this.createPane({
        id: `pane-${i}`,
        label: `Shell ${i}`,
        agentId: 'shell',
        trigger: 'app-boot-default-shell'
      });
    }
    this.paneIdCounter = Math.max(this.paneIdCounter, count + 1);
  }

  async syncPanesToOpenedFolder(canonicalRoot) {
    if (!canonicalRoot) return;
    for (const pane of this.panes.values()) {
      pane.setCwd(canonicalRoot);
      // Chat panes do not spawn child processes. Future tool calls read the
      // main-process ProjectRoot again, while terminal sessions must restart
      // immediately so manually entered Codex/Claude/Aider commands cannot
      // retain the pre-opened app/install cwd.
      if (!(pane instanceof CustomModelPane)) {
        await this.restartPane(pane.id, { killTmux: true, trigger: 'opened-folder-sync' });
      }
    }
    this.showBanner(`Opened folder: ${canonicalRoot}. All terminal sessions now use this working directory.`);
  }

  async killAllSessions() {
    const ok = window.__IDE_TEST_MODE__ || confirm('Kill all active and orphaned tmux sessions?');
    if (!ok) return;

    try {
      await window.electronAPI.killAllSessions();
    } catch (err) {
      this.showBanner(`Kill all failed: ${err.message}`, 'error');
    }
    // Mark all panes exited, then clear the grid (which calls destroy on each)
    for (const pane of this.panes.values()) {
      pane.status = 'exited'; // raw set \u2014 don't trigger callbacks on dead panes
    }
    this.panes.clear();
    this.gridManager.clearAll();
    this.focusedPaneId = null;
    this.updateFooter();
    this.renderEditorTabs();
    this.renderSidebarSessions();
  }

  showOrphanModal(orphans) {
    this.orphansList.innerHTML = '';
    orphans.forEach((sessionName) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span><strong>${this.escapeHtml(sessionName)}</strong></span>
        <button class="btn btn-primary btn-reattach-single" data-session="${this.escapeHtml(sessionName)}" type="button">Reattach</button>
      `;
      this.orphansList.appendChild(li);
    });

    this.orphansList.querySelectorAll('.btn-reattach-single').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const sName = e.currentTarget.dataset.session;
        await this.createPane({
          id: sName.replace(/^ide-/, ''),
          label: sName,
          customSessionName: sName,
          forceNew: false,
          agentId: 'shell'
        });
        e.currentTarget.closest('li').remove();
        if (this.orphansList.children.length === 0) {
          this.modalOrphans.classList.add('hidden');
        }
      });
    });

    this.modalOrphans.classList.remove('hidden');
  }

  async reattachAllOrphans(orphans) {
    for (const sessionName of orphans) {
      await this.createPane({
        id: sessionName.replace(/^ide-/, ''),
        label: sessionName,
        customSessionName: sessionName,
        forceNew: false,
        agentId: 'shell'
      });
    }
    this.modalOrphans.classList.add('hidden');
  }

  async loadWorkspaceOptions() {
    this.workspaces = await window.electronAPI.getWorkspaces() || {};
    this.workspaceSelect.innerHTML = '<option value="">\u2014 Workspace \u2014</option>';
    for (const name of Object.keys(this.workspaces)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      this.workspaceSelect.appendChild(opt);
    }
    if (this.activeWorkspaceName) {
      this.workspaceSelect.value = this.activeWorkspaceName;
    }
    this.renderSidebarWorkspaces();
  }

  async saveCurrentWorkspace() {
    const suggested = this.activeWorkspaceName || 'My Project Workspace';
    const name = window.__IDE_TEST_MODE__
      ? (window.__IDE_TEST_WORKSPACE_NAME__ || suggested)
      : prompt('Enter a name for this workspace preset:', suggested);
    if (!name || !String(name).trim()) return;

    const paneConfigs = [];
    for (const pane of this.panes.values()) {
      paneConfigs.push({
        id: pane.id,
        label: pane.label,
        cwd: pane.cwd,
        agentId: pane.agentId,
        customModelId: pane instanceof CustomModelPane ? pane.model.id : null
      });
    }

    const layout = {
      preset: this.gridManager.preset,
      panes: paneConfigs
    };

    await window.electronAPI.saveWorkspace(String(name).trim(), layout);
    this.activeWorkspaceName = String(name).trim();
    await this.loadWorkspaceOptions();
    this.workspaceSelect.value = this.activeWorkspaceName;
    this.updateFooter();
    if (!window.__IDE_TEST_MODE__) {
      this.showBanner(`Workspace "${this.activeWorkspaceName}" saved.`);
    }
  }

  async loadSelectedWorkspace(name) {
    if (!name) return;
    const workspace = await window.electronAPI.loadWorkspace(name);
    if (!workspace) {
      this.showBanner(`Workspace "${name}" not found.`, 'error');
      return;
    }

    // Teardown existing panes (detach only)
    for (const paneId of Array.from(this.panes.keys())) {
      await this.removePane(paneId);
    }

    if (workspace.preset) {
      this.gridManager.setPreset(workspace.preset);
      this.btnPreset2x3.classList.toggle('active', workspace.preset === '2x3');
      this.btnPreset3x2.classList.toggle('active', workspace.preset === '3x2');
    }

    if (workspace.panes && Array.isArray(workspace.panes)) {
      for (const pConf of workspace.panes) {
        await this.createPane({
          id: pConf.id,
          label: pConf.label,
          cwd: pConf.cwd,
          agentId: pConf.agentId,
          customModel: pConf.customModelId ? this.customModels.find((m) => m.id === pConf.customModelId) : null
        });
      }
    }

    this.activeWorkspaceName = name;
    this.workspaceSelect.value = name;
    this.updateFooter();
    this.renderSidebarWorkspaces();
  }

  async deleteSelectedWorkspace() {
    const name = this.workspaceSelect.value;
    if (!name) {
      this.showBanner('Select a saved workspace to delete.');
      return;
    }
    const ok = window.__IDE_TEST_MODE__ || confirm(`Delete saved workspace "${name}"?`);
    if (!ok) return;
    await window.electronAPI.deleteWorkspace(name);
    if (this.activeWorkspaceName === name) this.activeWorkspaceName = null;
    await this.loadWorkspaceOptions();
    this.updateFooter();
  }

  /* ---------- Editor tabs ---------- */
  renderEditorTabs() {
    if (!this.editorTabsScroll) return;
    this.editorTabsScroll.innerHTML = '';
    for (const pane of this.panes.values()) {
      const tab = document.createElement('div');
      tab.className = 'editor-tab';
      tab.dataset.paneId = pane.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', pane.id === this.focusedPaneId ? 'true' : 'false');
      if (pane.id === this.focusedPaneId) tab.classList.add('active');
      if (pane.status === 'running') tab.classList.add('running');

      tab.innerHTML = `
        <span class="editor-tab-icon">&gt;_</span>
        <span class="editor-tab-label" title="${this.escapeHtml(pane.label)}">${this.escapeHtml(pane.label)}</span>
        <button class="editor-tab-action" type="button" title="Close" aria-label="Close ${this.escapeHtml(pane.label)}">\u00D7</button>
      `;

      tab.addEventListener('click', (e) => {
        if (e.target.closest('.editor-tab-action')) return;
        this.focusPane(pane.id);
      });
      tab.querySelector('.editor-tab-action').addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePane(pane.id);
      });

      this.editorTabsScroll.appendChild(tab);
    }
  }

  /* ---------- Sidebar ---------- */
  renderSidebarSessions() {
    if (!this.sidebarSessionsList) return;
    this.sidebarSessionsList.innerHTML = '';
    if (this.panes.size === 0) {
      this.sidebarSessionsList.innerHTML = '<div class="tree-empty">No active panes</div>';
      return;
    }
    for (const pane of this.panes.values()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-item' + (pane.id === this.focusedPaneId ? ' active' : '');
      row.dataset.paneId = pane.id;
      row.innerHTML = `
        <span class="tree-dot ${pane.status}"></span>
        <span class="tree-label">${this.escapeHtml(pane.label)}</span>
        <span class="tree-meta">${pane.status}</span>
      `;
      row.addEventListener('click', () => this.focusPane(pane.id));
      this.sidebarSessionsList.appendChild(row);
    }
  }

  renderSidebarWorkspaces() {
    if (!this.sidebarWorkspacesList) return;
    this.sidebarWorkspacesList.innerHTML = '';
    const names = Object.keys(this.workspaces || {});
    if (names.length === 0) {
      this.sidebarWorkspacesList.innerHTML = '<div class="tree-empty">Save a layout from the toolbar</div>';
      return;
    }
    names.forEach((name) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-item' + (name === this.activeWorkspaceName ? ' active' : '');
      row.innerHTML = `
        <span class="tree-label">${this.escapeHtml(name)}</span>
        <span class="tree-meta">load</span>
      `;
      row.addEventListener('click', () => {
        this.workspaceSelect.value = name;
        this.loadSelectedWorkspace(name);
      });
      this.sidebarWorkspacesList.appendChild(row);
    });
  }

  renderSidebarAgents() {
    if (!this.sidebarAgentsList) return;
    this.sidebarAgentsList.innerHTML = '';
    if (!this.agentsList.length) {
      this.sidebarAgentsList.innerHTML = '<div class="tree-empty">No agent presets</div>';
      return;
    }
    this.agentsList.forEach((agent) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-item agent-item';
      row.title = agent.description || agent.command || agent.name;
      row.innerHTML = `
        <span class="tree-label">${this.escapeHtml(agent.name)}</span>
        <span class="tree-meta agent-cmd">${this.escapeHtml(agent.command || 'shell')}</span>
      `;
      row.addEventListener('click', () => {
        const targetId = this.focusedPaneId || Array.from(this.panes.keys())[0];
        this.openRunAgentModal({ targetPaneId: targetId, selectedAgentId: agent.id });
      });
      this.sidebarAgentsList.appendChild(row);
    });
  }

  renderCustomModels() {
    if (!this.sidebarCustomModelsList) return;
    this.sidebarCustomModelsList.innerHTML = '';
    if (this.sidebarCustomModelCount) this.sidebarCustomModelCount.textContent = this.customModels.length;
    if (!this.customModels.length) { this.sidebarCustomModelsList.innerHTML = '<div class="tree-empty">No remote endpoints configured</div>'; return; }
    this.customModels.forEach((model) => {
      const row = document.createElement('div'); row.className = 'tree-item agent-item custom-model-item';
      row.innerHTML = `<span class="tree-label">${this.escapeHtml(model.name)}</span><span class="tree-meta">${this.escapeHtml(model.type === 'ollama' ? 'Ollama' : 'OpenAI')}</span><button class="custom-model-terminal-btn" type="button" title="Open terminal for ${this.escapeHtml(model.name)}" aria-label="Open terminal for ${this.escapeHtml(model.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 6-5-6-5M12 19h8"/></svg></button>`;
      row.addEventListener('click', () => this.openCustomModelModal(model));
      row.querySelector('.custom-model-terminal-btn').addEventListener('click', (event) => {
        event.stopPropagation();
        this.openCustomModelTerminal(model);
      });
      this.sidebarCustomModelsList.appendChild(row);
    });
  }

  ollamaHostForModel(model) {
    const host = String(model.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\/$/, '');
    const port = String(model.port || '').trim().replace(/^:/, '');
    if (!host) return '';
    if (!port || host.endsWith(`:${port}`)) return host;
    return `${host}:${port}`;
  }

  async openCustomModelTerminal(model) {
    const existing = [...this.panes.values()].find((pane) => pane.customModelId === model.id);
    if (existing) {
      this.focusPane(existing.id);
      if (existing.status !== 'running') await this.restartPane(existing.id, { killTmux: true, trigger: 'custom-model-terminal-reconnect' });
      return existing;
    }

    const pending = this.customModelTerminalCreates.get(model.id);
    if (pending) return pending;

    const ollamaHost = this.ollamaHostForModel(model);
    if (!ollamaHost) {
      this.showBanner(`Cannot open a terminal for "${model.name}": its host is missing.`, 'error');
      return null;
    }
    const create = this.createPane({
      label: model.name,
      agentId: 'shell',
      customModelId: model.id,
      envVars: { OLLAMA_HOST: ollamaHost },
      trigger: 'custom-model-terminal'
    });
    this.customModelTerminalCreates.set(model.id, create);
    try { return await create; } finally { this.customModelTerminalCreates.delete(model.id); }
  }

  openCustomModelModal(model = null) {
    this._editingCustomModelId = model?.id || null; this._detectedToolCapable = model?.toolCapable; this.customModelForm.reset(); this.customModelTestResult.textContent = '';
    ['name', 'host', 'port', 'type', 'model', 'apiKey'].forEach((key) => { if (model?.[key] != null) this.customModelForm.elements[key].value = model[key]; });
    document.getElementById('custom-model-title').textContent = model ? 'Edit Custom Model' : 'Add Custom Model';
    document.getElementById('btn-delete-custom-model').classList.toggle('hidden', !model); this.modalCustomModel.classList.remove('hidden');
  }
  closeCustomModelModal() { this.modalCustomModel.classList.add('hidden'); }
  customModelFromForm() { const data = Object.fromEntries(new FormData(this.customModelForm)); const likelyToolCapable = data.type === 'ollama' && /^(qwen3|qwen2\.5|llama3\.1|llama3\.2|mistral-nemo|mistral-small|command-r|hermes)/i.test(String(data.model || '')); const toolCapable = data.type === 'ollama' && (this._detectedToolCapable ?? likelyToolCapable); return { id: this._editingCustomModelId || `custom-${Date.now()}`, ...data, port: String(data.port).trim(), toolCapable }; }
  async saveCustomModel() { if (!this.customModelForm.reportValidity()) return; const model = this.customModelFromForm(); const i = this.customModels.findIndex((m) => m.id === model.id); if (i >= 0) this.customModels[i] = model; else this.customModels.push(model); this.customModels = await window.electronAPI.saveCustomModels(this.customModels); this.renderCustomModels(); this.closeCustomModelModal(); }
  async testCustomModel() { if (!this.customModelForm.reportValidity()) return; const r = await window.electronAPI.testCustomModel(this.customModelFromForm()); if (r.success) this._detectedToolCapable = r.toolCapable; this.customModelTestResult.className = `custom-model-test-result ${r.success ? 'success' : 'error'}`; this.customModelTestResult.textContent = r.success ? `Connected: ${r.message}. ${r.toolCapable ? 'Tool calling available; agent mode will be enabled.' : 'Tool calling is not detected; this model will use plain chat.'}` : `Connection failed: ${r.error}`; }

  openRunAgentModal({ targetPaneId, selectedAgentId }) {
    if (!this.modalRunAgent) return;
    this._runAgentTargetPaneId = targetPaneId || (this.focusedPaneId || Array.from(this.panes.keys())[0]);
    this.runAgentSelect.innerHTML = '';
    this.agentsList.forEach((agent) => {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agent.name;
      if (agent.id === selectedAgentId) opt.selected = true;
      this.runAgentSelect.appendChild(opt);
    });
    this.customModels.forEach((model) => { const opt = document.createElement('option'); opt.value = `custom:${model.id}`; opt.textContent = `${model.name} (remote)`; this.runAgentSelect.appendChild(opt); });

    const updateDesc = () => {
      const selected = this.agentsList.find((a) => a.id === this.runAgentSelect.value);
      const custom = this.customModels.find((m) => `custom:${m.id}` === this.runAgentSelect.value);
      if (this.runAgentDesc) {
        this.runAgentDesc.textContent = custom ? `${custom.type === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} endpoint at ${custom.host}:${custom.port}` : (selected ? (selected.description || selected.command || selected.name) : '');
      }
    };
    this.runAgentSelect.onchange = updateDesc;
    updateDesc();

    this.modalRunAgent.classList.remove('hidden');
  }

  closeRunAgentModal() {
    if (this.modalRunAgent) this.modalRunAgent.classList.add('hidden');
  }

  async executeAgent({ targetPaneId, agentId, scope }) {
    if (agentId.startsWith('custom:')) {
      const model = this.customModels.find((m) => m.id === agentId.slice(7));
      if (!model) return this.showBanner('That custom model no longer exists.', 'error');
      const targets = scope === 'all' ? Array.from(this.panes.keys()) : [targetPaneId];
      (async () => {
        for (const paneId of targets) {
          const old = this.panes.get(paneId); if (!old) continue;
          await this.removePane(paneId);
          await this.createPane({ id: paneId, label: scope === 'all' ? `${model.name}` : model.name, cwd: old.cwd, customModel: model });
        }
      })();
      return;
    }
    const agentObj = this.agentsList.find((a) => a.id === agentId);
    if (!agentObj) return;

    const startInProjectRoot = async (pane) => {
      // Run Agent starts a new CLI session in the open project, even when the
      // target is a default pane that was created before Open Folder. This
      // uses the same main-process root resolution as ordinary new panes.
      const projectRoot = await window.electronAPI.getProjectRoot();
      if (!projectRoot) throw new Error('Could not resolve working directory: open a project folder before running an agent.');
      if (pane.cwd !== projectRoot) await this.changePaneCwd(pane.id, projectRoot);
      if (this.panes.get(pane.id)?.cwd !== projectRoot) throw new Error(`Could not resolve working directory: pane did not restart in ${projectRoot}.`);
    };

    // Launch the chosen CLI by replacing the PTY session instead of typing a
    // command into an old shell. This makes the main process the observable
    // spawn point and guarantees the command cannot inherit a stale cwd.
    const launchInPane = async (pane, trigger) => {
      await startInProjectRoot(pane);
      pane.agentId = agentObj.id;
      await this.restartPane(pane.id, { killTmux: true, trigger });
      if (this.panes.get(pane.id)?.cwd !== await window.electronAPI.getProjectRoot()) {
        throw new Error('Could not resolve working directory: agent session did not start in the opened folder.');
      }
    };

    if (scope === 'single') {
      const pane = this.panes.get(targetPaneId);
      if (pane) {
        try { await launchInPane(pane, 'run-agent-button'); } catch (error) { this.showBanner(error.message, 'error'); return; }
        pane.label = agentObj.name;
        pane.labelInput.value = agentObj.name;
        pane.agentSelect.value = agentObj.id;
      }
    } else if (scope === 'all') {
      let idx = 1;
      for (const pane of this.panes.values()) {
        try { await launchInPane(pane, 'run-agent-all'); } catch (error) { this.showBanner(error.message, 'error'); return; }
        const nameLabel = this.panes.size > 1 ? `${agentObj.name} ${idx++}` : agentObj.name;
        pane.label = nameLabel;
        pane.labelInput.value = nameLabel;
        pane.agentSelect.value = agentObj.id;
      }
    }

    this.renderEditorTabs();
    this.renderSidebarSessions();
    this.updateFooter();
  }

  toggleSidebarSection(section) {
    const header = document.querySelector(`[data-toggle-section="${section}"]`);
    const content = document.querySelector(`.sidebar-section[data-section="${section}"] .sidebar-section-content`);
    if (!header || !content) return;
    const chevron = header.querySelector('.codicon-chevron');
    const collapsed = content.classList.toggle('collapsed');
    if (chevron) chevron.classList.toggle('expanded', !collapsed);
  }

  toggleSidebar(force) {
    this.sidebarCollapsed = force != null ? force : !this.sidebarCollapsed;
    if (this.sideBar) this.sideBar.classList.toggle('collapsed', this.sidebarCollapsed);
    if (this.appShell) this.appShell.classList.toggle('sidebar-collapsed', this.sidebarCollapsed);
    // Reflow terminals after layout change \u2014 use transitionend for animated sidebar
    const onDone = () => {
      this.gridManager && this.gridManager.reflowAll();
    };
    if (this.sideBar) {
      this.sideBar.addEventListener('transitionend', onDone, { once: true });
    }
    // Fallback in case transitionend doesn't fire
    setTimeout(onDone, 200);
  }

  setupSidebarResize() {
    const sash = document.getElementById('sidebar-sash');
    if (!sash || !this.sideBar) return;
    sash.addEventListener('pointerdown', (e) => {
      if (this.sidebarCollapsed) return;
      e.preventDefault();
      sash.classList.add('dragging');
      sash.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.sideBar.getBoundingClientRect().width;
      const onMove = (ev) => {
        const next = Math.min(480, Math.max(160, startW + (ev.clientX - startX)));
        this.sidebarWidth = next;
        this.sideBar.style.width = `${next}px`;
        this.sideBar.style.flexBasis = `${next}px`;
        this.gridManager && this.gridManager.reflowAll();
      };
      const onUp = () => {
        sash.classList.remove('dragging');
        try { sash.releasePointerCapture(e.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.gridManager && this.gridManager.reflowAll();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  /* ---------- Command Palette ---------- */
  getCommands() {
    return [
      { id: 'new-pane', label: 'Terminal: New Pane', accel: 'Ctrl+Shift+N', run: () => this.createPane({}) },
      { id: 'close-pane', label: 'Terminal: Close Focused Pane', accel: 'Ctrl+Shift+W', run: () => this.focusedPaneId && this.removePane(this.focusedPaneId) },
      { id: 'broadcast', label: 'Terminal: Toggle Broadcast Mode', accel: 'Ctrl+Shift+B', run: () => window.broadcastManager.toggle() },
      { id: 'kill-all', label: 'Terminal: Kill All Sessions', accel: 'Ctrl+Shift+K', run: () => this.killAllSessions() },
      { id: 'save-ws', label: 'Workspace: Save Current Layout', accel: '', run: () => this.saveCurrentWorkspace() },
      { id: 'load-ws', label: 'Workspace: Open Select\u2026', accel: '', run: () => this.workspaceSelect && this.workspaceSelect.focus() },
      { id: 'grid-2x3', label: 'View: 2\u00D73 Grid Layout', accel: '', run: () => this.setGridPreset('2x3') },
      { id: 'grid-3x2', label: 'View: 3\u00D72 Grid Layout', accel: '', run: () => this.setGridPreset('3x2') },
      { id: 'toggle-sidebar', label: 'View: Toggle Side Bar', accel: 'Ctrl+B', run: () => this.toggleSidebar() },
      { id: 'search', label: 'Terminal: Search Scrollback', accel: 'Ctrl+F', run: () => this.searchFocusedTerminal() },
      { id: 'help', label: 'Help: Keyboard Shortcuts', accel: '', run: () => this.modalHelp.classList.remove('hidden') },
      { id: 'focus-1', label: 'Terminal: Focus Pane 1', accel: 'Ctrl+1', run: () => this.focusPaneByIndex(0) },
      { id: 'focus-2', label: 'Terminal: Focus Pane 2', accel: 'Ctrl+2', run: () => this.focusPaneByIndex(1) },
      { id: 'focus-3', label: 'Terminal: Focus Pane 3', accel: 'Ctrl+3', run: () => this.focusPaneByIndex(2) },
      { id: 'focus-4', label: 'Terminal: Focus Pane 4', accel: 'Ctrl+4', run: () => this.focusPaneByIndex(3) },
      { id: 'check-tmux', label: 'tmux: Recheck Connection', accel: '', run: () => this.checkTmux() },
      { id: 'list-orphans', label: 'tmux: Show Orphan Sessions', accel: '', run: async () => {
        const orphans = await window.electronAPI.listOrphans();
        if (orphans.length) this.showOrphanModal(orphans);
        else this.showBanner('No orphaned ide-* tmux sessions found.');
      }}
    ];
  }

  setupCommandPalette() {
    const openBtn = document.getElementById('btn-command-palette');
    if (openBtn) openBtn.addEventListener('click', () => this.openCommandPalette());

    this.commandPalette.addEventListener('click', (e) => {
      if (e.target === this.commandPalette) this.closeCommandPalette();
    });

    this.commandPaletteInput.addEventListener('input', () => this.filterCommandPalette());
    this.commandPaletteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCommandPalette();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.commandPaletteIndex = Math.min(this.commandPaletteIndex + 1, this.commandPaletteFiltered.length - 1);
        this.renderCommandPaletteList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.commandPaletteIndex = Math.max(this.commandPaletteIndex - 1, 0);
        this.renderCommandPaletteList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.runSelectedCommand();
      }
    });
  }

  openCommandPalette() {
    this.commandPalette.classList.remove('hidden');
    this.commandPaletteInput.value = '';
    this.commandPaletteIndex = 0;
    this.filterCommandPalette();
    setTimeout(() => this.commandPaletteInput.focus(), 0);
  }

  closeCommandPalette() {
    this.commandPalette.classList.add('hidden');
  }

  filterCommandPalette() {
    const q = (this.commandPaletteInput.value || '').trim().toLowerCase();
    const all = this.getCommands();
    this.commandPaletteFiltered = q
      ? all.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
      : all;
    this.commandPaletteIndex = 0;
    this.renderCommandPaletteList();
  }

  renderCommandPaletteList() {
    this.commandPaletteList.innerHTML = '';
    if (!this.commandPaletteFiltered.length) {
      this.commandPaletteList.innerHTML = '<li class="command-palette-empty">No matching commands</li>';
      return;
    }
    this.commandPaletteFiltered.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = 'command-palette-item' + (i === this.commandPaletteIndex ? ' selected' : '');
      li.setAttribute('role', 'option');
      li.innerHTML = `<span class="cmd-label">${this.escapeHtml(cmd.label)}</span><span class="cmd-accel">${this.escapeHtml(cmd.accel || '')}</span>`;
      li.addEventListener('click', () => {
        this.commandPaletteIndex = i;
        this.runSelectedCommand();
      });
      this.commandPaletteList.appendChild(li);
    });
    const selected = this.commandPaletteList.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  runSelectedCommand() {
    const cmd = this.commandPaletteFiltered[this.commandPaletteIndex];
    this.closeCommandPalette();
    if (cmd && typeof cmd.run === 'function') {
      Promise.resolve(cmd.run()).catch((err) => {
        this.showBanner(err.message || String(err), 'error');
      });
    }
  }

  /* ---------- Menubar ---------- */
  setupMenubar() {
    const menus = {
      file: [
        { label: 'Open Folder\u2026', accel: 'Ctrl+O', run: () => this.fileExplorer && this.fileExplorer.handleOpenFolderClick() },
        { sep: true },
        { label: 'New Pane', accel: 'Ctrl+Shift+N', run: () => this.createPane({}) },
        { label: 'Save Workspace\u2026', run: () => this.saveCurrentWorkspace() },
        { label: 'Delete Workspace', run: () => this.deleteSelectedWorkspace() },
        { sep: true },
        { label: 'Kill All Sessions', accel: 'Ctrl+Shift+K', run: () => this.killAllSessions() }
      ],
      terminal: [
        { label: 'New Pane', accel: 'Ctrl+Shift+N', run: () => this.createPane({}) },
        { label: 'Close Pane', accel: 'Ctrl+Shift+W', run: () => this.focusedPaneId && this.removePane(this.focusedPaneId) },
        { label: 'Toggle Broadcast', accel: 'Ctrl+Shift+B', run: () => window.broadcastManager.toggle() },
        { sep: true },
        { label: 'Search Scrollback', accel: 'Ctrl+F', run: () => this.searchFocusedTerminal() }
      ],
      view: [
        { label: 'Command Palette\u2026', accel: 'Ctrl+Shift+P', run: () => this.openCommandPalette() },
        { label: 'Toggle Side Bar', accel: 'Ctrl+B', run: () => this.toggleSidebar() },
        { label: 'Toggle Full Screen', accel: 'F11', run: () => window.electronAPI.controlWindow('toggle-fullscreen') },
        { sep: true },
        { label: '2\u00D73 Grid', run: () => this.setGridPreset('2x3') },
        { label: '3\u00D72 Grid', run: () => this.setGridPreset('3x2') }
      ],
      help: [
        { label: 'Keyboard Shortcuts', run: () => this.modalHelp.classList.remove('hidden') }
      ]
    };

    document.querySelectorAll('.menubar-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.menu;
        const items = menus[key];
        if (!items) return;
        this.openMenubarDropdown(btn, items);
      });
    });

    document.addEventListener('click', () => this.closeMenubarDropdown());
  }

  openMenubarDropdown(anchor, items) {
    const rect = anchor.getBoundingClientRect();
    this.menubarDropdown.innerHTML = '';
    items.forEach((item) => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menubar-dropdown-sep';
        this.menubarDropdown.appendChild(sep);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menubar-dropdown-item';
      b.innerHTML = `<span>${this.escapeHtml(item.label)}</span><span class="accel">${this.escapeHtml(item.accel || '')}</span>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeMenubarDropdown();
        item.run && item.run();
      });
      this.menubarDropdown.appendChild(b);
    });
    this.menubarDropdown.style.left = `${rect.left}px`;
    this.menubarDropdown.style.top = `${rect.bottom}px`;
    this.menubarDropdown.classList.remove('hidden');
    document.querySelectorAll('.menubar-item').forEach((el) => el.classList.remove('open'));
    anchor.classList.add('open');
  }

  closeMenubarDropdown() {
    this.menubarDropdown.classList.add('hidden');
    document.querySelectorAll('.menubar-item').forEach((el) => el.classList.remove('open'));
  }

  setGridPreset(preset) {
    this.gridManager.setPreset(preset);
    this.btnPreset2x3.classList.toggle('active', preset === '2x3');
    this.btnPreset3x2.classList.toggle('active', preset === '3x2');
  }

  focusPaneByIndex(index) {
    const keys = Array.from(this.panes.keys());
    if (index >= 0 && index < keys.length) this.focusPane(keys[index]);
  }

  attachEventListeners() {
    const windowControl = (id, action) => document.getElementById(id)?.addEventListener('click', () => window.electronAPI.controlWindow(action));
    windowControl('btn-window-minimize', 'minimize');
    windowControl('btn-window-fullscreen', 'toggle-fullscreen');
    windowControl('btn-window-close', 'close');
    document.getElementById('titlebar')?.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) window.electronAPI.controlWindow('toggle-maximize');
    });
    this.btnAddPane.addEventListener('click', () => this.createPane({}));
    this.btnKillAll.addEventListener('click', () => this.killAllSessions());
    this.btnTabAdd.addEventListener('click', () => this.createPane({}));
    if (this.btnTabClose) {
      this.btnTabClose.addEventListener('click', () => {
        if (this.focusedPaneId) this.removePane(this.focusedPaneId);
        else this.showBanner('Select a terminal pane to close.');
      });
    }

    const btnSidebarNew = document.getElementById('btn-sidebar-new-pane');
    if (btnSidebarNew) btnSidebarNew.addEventListener('click', () => this.createPane({}));
    const btnSidebarCollapse = document.getElementById('btn-sidebar-collapse');
    if (btnSidebarCollapse) btnSidebarCollapse.addEventListener('click', () => this.toggleSidebar());

    document.querySelectorAll('.activity-item').forEach((button) => {
      button.addEventListener('click', () => this.handleActivity(button));
    });

    document.querySelectorAll('[data-toggle-section]').forEach((btn) => {
      btn.addEventListener('click', () => this.toggleSidebarSection(btn.dataset.toggleSection));
    });

    this.btnPreset2x3.addEventListener('click', () => this.setGridPreset('2x3'));
    this.btnPreset3x2.addEventListener('click', () => this.setGridPreset('3x2'));
    this.btnSaveWorkspace.addEventListener('click', () => this.saveCurrentWorkspace());
    this.btnDeleteWorkspace.addEventListener('click', () => this.deleteSelectedWorkspace());
    this.workspaceSelect.addEventListener('change', (e) => this.loadSelectedWorkspace(e.target.value));
    this.bannerClose.addEventListener('click', () => this.hideBanner());
    this.btnAddCustomModel?.addEventListener('click', () => this.openCustomModelModal());
    document.getElementById('modal-custom-model-close')?.addEventListener('click', () => this.closeCustomModelModal());
    document.getElementById('btn-save-custom-model')?.addEventListener('click', () => this.saveCustomModel());
    document.getElementById('btn-test-custom-model')?.addEventListener('click', () => this.testCustomModel());
    document.getElementById('btn-delete-custom-model')?.addEventListener('click', async () => {
      this.customModels = this.customModels.filter((m) => m.id !== this._editingCustomModelId);
      this.customModels = await window.electronAPI.saveCustomModels(this.customModels); this.renderCustomModels(); this.closeCustomModelModal();
    });

    this.btnHelp.addEventListener('click', () => this.modalHelp.classList.remove('hidden'));
    this.modalHelpClose.addEventListener('click', () => this.modalHelp.classList.add('hidden'));
    this.modalHelpOk.addEventListener('click', () => this.modalHelp.classList.add('hidden'));
    this.modalOrphansClose.addEventListener('click', () => this.modalOrphans.classList.add('hidden'));

    if (this.modalRunAgentClose) this.modalRunAgentClose.addEventListener('click', () => this.closeRunAgentModal());
    if (this.btnRunAgentCancel) this.btnRunAgentCancel.addEventListener('click', () => this.closeRunAgentModal());

    if (this.btnRunAgentSingle) {
      this.btnRunAgentSingle.addEventListener('click', () => {
        const agentId = this.runAgentSelect.value;
        this.closeRunAgentModal();
        this.executeAgent({ targetPaneId: this._runAgentTargetPaneId, agentId, scope: 'single' });
      });
    }

    if (this.btnRunAgentAll) {
      this.btnRunAgentAll.addEventListener('click', () => {
        const agentId = this.runAgentSelect.value;
        this.closeRunAgentModal();
        this.executeAgent({ targetPaneId: null, agentId, scope: 'all' });
      });
    }

    this.btnOrphansReattachAll.addEventListener('click', async () => {
      // Use the sessions still visible in the modal, not a fresh IPC query,
      // to avoid double-reattaching sessions the user already individually reattached.
      const remaining = [...this.orphansList.querySelectorAll('.btn-reattach-single')]
        .map((btn) => btn.dataset.session)
        .filter(Boolean);
      await this.reattachAllOrphans(remaining);
    });
    this.btnOrphansKillAll.addEventListener('click', async () => {
      await window.electronAPI.killAllSessions();
      this.modalOrphans.classList.add('hidden');
    });

    // Window resize safety net (in addition to ResizeObserver)
    window.addEventListener('resize', () => {
      if (this.gridManager) this.gridManager.reflowAll();
    });
  }

  setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't steal keys while typing in inputs/selects (except palette/global)
      const tag = (e.target && e.target.tagName) || '';
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);

      // Ctrl+Shift+P \u2014 Command Palette (always)
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        this.openCommandPalette();
        return;
      }

      // Escape closes overlays
      if (e.key === 'Escape') {
        if (!this.commandPalette.classList.contains('hidden')) {
          e.preventDefault();
          this.closeCommandPalette();
          return;
        }
        this.closeMenubarDropdown();
        return;
      }

      if (isEditable && e.target !== this.commandPaletteInput) {
        // Allow Ctrl+1..6 etc. only with modifiers; plain typing goes to input
        // Still allow global shortcuts with Ctrl+Shift
      }

      // Ctrl+1..6 \u2014 focus pane (requires Ctrl, so typing "1" in shell is safe)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '6') {
        const index = parseInt(e.key, 10) - 1;
        const paneKeys = Array.from(this.panes.keys());
        if (index < paneKeys.length) {
          e.preventDefault();
          this.focusPane(paneKeys[index]);
        }
        return;
      }

      if (e.ctrlKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        this.createPane({});
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
        e.preventDefault();
        if (this.focusedPaneId) this.removePane(this.focusedPaneId);
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        window.broadcastManager.toggle();
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        this.killAllSessions();
        return;
      }
      // Ctrl+O \u2014 Open Folder
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        if (this.fileExplorer) this.fileExplorer.handleOpenFolderClick();
        return;
      }

      // Ctrl+B \u2014 toggle sidebar (not when shift held)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        // Skip if focus is inside an xterm terminal \u2014 Ctrl+B is the tmux prefix key.
        // Only intercept when focus is on a non-terminal element (matching VS Code behavior).
        const inTerminal = e.target && (e.target.closest('.xterm') || e.target.classList.contains('xterm-helper-textarea'));
        if (inTerminal) return; // let tmux handle it
        e.preventDefault();
        this.toggleSidebar();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        this.searchFocusedTerminal();
      }
    }, true);
  }

  handleActivity(button) {
    document.querySelectorAll('.activity-item').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const activity = button.dataset.activity;

    if (activity === 'explorer' || activity === 'agents' || activity === 'terminal') {
      if (this.sidebarCollapsed) this.toggleSidebar(false);
      const title = document.getElementById('side-bar-title');
      if (title) {
        title.textContent = activity === 'agents' ? 'AGENTS'
          : activity === 'terminal' ? 'TERMINALS' : 'EXPLORER';
      }
      if (activity === 'terminal') {
        const pane = this.panes.get(this.focusedPaneId) || this.panes.values().next().value;
        if (pane) this.focusPane(pane.id);
      }
    } else if (activity === 'search') {
      this.searchFocusedTerminal();
    } else if (activity === 'settings') {
      this.modalHelp.classList.remove('hidden');
    }
  }

  searchFocusedTerminal() {
    const pane = this.panes.get(this.focusedPaneId);
    if (!pane || !pane.searchAddon) {
      this.showBanner('Select an active terminal pane before searching.');
      return;
    }
    const query = window.__IDE_TEST_MODE__
      ? (window.__IDE_TEST_SEARCH_QUERY__ || '')
      : prompt('Search terminal scrollback:');
    if (query) {
      pane.searchAddon.findNext(query, {
        incremental: false,
        decorations: { activeMatchBackground: '#264f78', matchBackground: '#623d18' }
      });
    }
  }

  updateFooter() {
    const total = this.panes.size;
    if (this.panesCountEl) this.panesCountEl.textContent = `Sessions: ${total}/6`;
    if (this.sidebarPaneCountEl) this.sidebarPaneCountEl.textContent = String(total);

    if (this.focusedPaneId) {
      const pane = this.panes.get(this.focusedPaneId);
      if (this.focusedPaneInfo) {
        this.focusedPaneInfo.textContent = `Focused: ${pane ? pane.label : this.focusedPaneId}`;
      }
    } else if (this.focusedPaneInfo) {
      this.focusedPaneInfo.textContent = 'Focused: None';
    }

    if (this.statusWorkspace) {
      this.statusWorkspace.textContent = `Workspace: ${this.activeWorkspaceName || 'Default'}`;
    }
    if (this.titlebarTitle) {
      const ws = this.activeWorkspaceName || 'Untitled';
      this.titlebarTitle.textContent = `${ws} \u2014 Agent Terminal IDE`;
    }

    // Keep broadcast status in sync
    if (window.broadcastManager) window.broadcastManager.updateUI();
  }

  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  window.appInstance = app;
  app.init().catch((err) => {
    console.error('App init failed:', err);
  });
});
