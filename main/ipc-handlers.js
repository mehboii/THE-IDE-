const { ipcMain, dialog, clipboard } = require('electron');
const ptyManager = require('./pty-manager');
const agentConfig = require('./agent-config');
const workspaceStore = require('./workspace-store');
const customModelStore = require('./custom-model-store');
const customModelService = require('./custom-model-service');
const projectRoot = require('./project-root');

function registerIpcHandlers({ openEditorFile } = {}) {
  // The active project root is deliberately main-process state so the file
  // tree, PTY spawner, and model tool loop cannot silently drift apart.
  ipcMain.handle('project-root:get', () => projectRoot.get());
  ipcMain.handle('project-root:set', (event, root) => projectRoot.set(root));

  // PTY session handlers
  ipcMain.handle('pty:create', async (event, params) => {
    return ptyManager.createSession(params);
  });

  ipcMain.on('pty:write', (event, { paneId, data }) => {
    ptyManager.write(paneId, data);
  });

  ipcMain.on('pty:resize', (event, { paneId, cols, rows }) => {
    ptyManager.resize(paneId, cols, rows);
  });

  ipcMain.handle('pty:destroy', async (event, { paneId, killTmux }) => {
    await ptyManager.destroySession(paneId, killTmux);
    return { success: true };
  });

  ipcMain.handle('pty:restart', async (event, params) => {
    // Kill old tmux session by default so Restart always spawns a fresh PTY,
    // not a reattach to a dead session. Pass forceNew:false to reattach only.
    const forceNew = params.forceNew !== false;
    await ptyManager.destroySession(params.paneId, forceNew);
    return ptyManager.createSession({ ...params, forceNew });
  });

  // tmux management handlers
  ipcMain.handle('tmux:check', async () => {
    return ptyManager.checkTmuxAvailable();
  });

  ipcMain.handle('tmux:list-orphans', async () => {
    return ptyManager.listOrphanSessions();
  });

  ipcMain.handle('tmux:kill-session', async (event, { sessionName }) => {
    return ptyManager.killTmuxSession(sessionName);
  });

  ipcMain.handle('tmux:kill-all', async () => {
    return ptyManager.killAllTmuxSessions();
  });

  // Agent Preset handlers
  ipcMain.handle('agents:list', async () => {
    return agentConfig.loadAgents();
  });

  ipcMain.handle('agents:save', async (event, agentsList) => {
    return agentConfig.saveAgents(agentsList);
  });

  // Custom remote models always use main-process networking. The renderer only
  // receives sanitized configuration and streamed tokens through IPC.
  ipcMain.handle('custom-models:list', () => customModelStore.list());
  ipcMain.handle('custom-models:save', (event, models) => customModelStore.save(models));
  ipcMain.handle('custom-models:test', (event, model) => customModelService.testConnection(model));
  ipcMain.handle('custom-models:chat', (event, payload) => customModelService.streamChat(event.sender, payload.paneId, payload.model, payload.messages, payload.cwd, payload.fullAutoApprove, payload.maxIterations));
  ipcMain.handle('custom-models:tool-decision', (event, { callId, approved }) => customModelService.resolveApproval(callId, approved));

  // Keep terminal clipboard access inside Electron rather than relying on the
  // renderer having browser clipboard permissions.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('clipboard:write-text', (event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  // Workspace Storage handlers
  ipcMain.handle('workspaces:get-all', async () => {
    return workspaceStore.getWorkspaces();
  });

  ipcMain.handle('workspaces:save', async (event, { name, layout }) => {
    return workspaceStore.saveWorkspace(name, layout);
  });

  ipcMain.handle('workspaces:load', async (event, { name }) => {
    return workspaceStore.loadWorkspace(name);
  });

  ipcMain.handle('workspaces:delete', async (event, { name }) => {
    return workspaceStore.deleteWorkspace(name);
  });

  // Directory picker dialog handler
  ipcMain.handle('dialog:select-directory', async (event, defaultPath) => {
    if (process.env.IDE_TEST_MODE === '1' && global.__TEST_DIRECTORY_PATH__) {
      const selected = global.__TEST_DIRECTORY_PATH__;
      global.__TEST_DIRECTORY_PATH__ = null;
      return selected;
    }
    const window = event.sender.getOwnerBrowserWindow();
    const result = await dialog.showOpenDialog(window, {
      title: 'Select Working Directory',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('test:set-save-as-path', (event, targetPath) => {
    global.__TEST_SAVE_AS_PATH__ = targetPath;
    return true;
  });
  ipcMain.handle('test:set-directory-path', (event, targetPath) => {
    global.__TEST_DIRECTORY_PATH__ = targetPath;
    return true;
  });

  // The main renderer requests editor files through this channel. It never
  // mounts Monaco itself; the file is delivered to the editor BrowserWindow.
  ipcMain.handle('editor:open-file', (event, filePath) => {
    if (typeof openEditorFile === 'function') openEditorFile(filePath);
    return true;
  });

  ipcMain.handle('dialog:show-save-dialog', async (event, defaultPath) => {
    if (process.env.IDE_TEST_MODE === '1' && global.__TEST_SAVE_AS_PATH__) {
      const p = global.__TEST_SAVE_AS_PATH__;
      global.__TEST_SAVE_AS_PATH__ = null;
      return p;
    }
    const window = event.sender.getOwnerBrowserWindow();
    const result = await dialog.showSaveDialog(window, {
      title: 'Save File As',
      defaultPath: defaultPath || undefined
    });

    if (!result.canceled && result.filePath) {
      return result.filePath;
    }
    return null;
  });

  // Filesystem IPC handlers
  const fs = require('fs');
  const path = require('path');
  const fileWatchers = new Map();
  const watcherKey = (sender, filePath) => `${sender.id}:${filePath}`;
  const closeSenderWatchers = (sender) => {
    const prefix = `${sender.id}:`;
    for (const [key, watcher] of fileWatchers) {
      if (key.startsWith(prefix)) {
        try { watcher.close(); } catch (_) {}
        fileWatchers.delete(key);
      }
    }
  };

  function resolveFsPath(targetPath) {
    if (!targetPath) throw new Error('Could not resolve working directory: no file path was provided.');
    if (path.isAbsolute(targetPath)) return targetPath;
    return path.resolve(projectRoot.resolveWorkingDirectory(null, 'filesystem operation'), targetPath);
  }

  ipcMain.handle('fs:read-dir', async (event, dirPath) => {
    try {
      const target = resolveFsPath(dirPath);
      if (!target || !fs.existsSync(target)) return [];
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const results = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(target, entry.name)
      }));

      // Sort directories first, then files alphabetically
      results.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return results;
    } catch (err) {
      console.error('fs:read-dir error:', err);
      return [];
    }
  });

  ipcMain.handle('fs:read-file', async (event, filePath) => {
    try {
      const target = resolveFsPath(filePath);
      const content = await fs.promises.readFile(target, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:write-file', async (event, { filePath, content }) => {
    try {
      const target = resolveFsPath(filePath);
      console.log(`[FS WRITE ASSERTION] IPC fs:write-file writing to path: ${target}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // fs.watch accepts both a file and a directory. The Explorer watches its
  // project root to receive structural changes made by terminal agents.
  ipcMain.handle('fs:watch-file', (event, filePath) => {
    const key = watcherKey(event.sender, filePath);
    if (!filePath || fileWatchers.has(key)) return true;
    try {
      let debounceTimer = null;
      const watcher = fs.watch(filePath, (eventType) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const win = event.sender.getOwnerBrowserWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('file-changed', { filePath });
          }
        }, 150);
      });
      fileWatchers.set(key, watcher);
      event.sender.once('destroyed', () => closeSenderWatchers(event.sender));
      return true;
    } catch (err) {
      console.error('fs:watch-file error:', err);
      return false;
    }
  });

  ipcMain.handle('fs:unwatch-file', (event, filePath) => {
    const key = watcherKey(event.sender, filePath);
    if (fileWatchers.has(key)) {
      try {
        fileWatchers.get(key).close();
      } catch (_) {}
      fileWatchers.delete(key);
    }
    return true;
  });

  // Runner & Debugger IPC handlers
  const runner = require('./runner');
  ipcMain.handle('runner:execute', (event, payload) => runner.execute(event.sender, payload));
  ipcMain.handle('runner:stop', (event, runId) => runner.stop(runId));
  ipcMain.handle('runner:debug-command', (event, { runId, command }) => runner.sendDebugCommand(runId, command));
}

module.exports = { registerIpcHandlers };
