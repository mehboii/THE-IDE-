const { ipcMain, dialog } = require('electron');
const ptyManager = require('./pty-manager');
const agentConfig = require('./agent-config');
const workspaceStore = require('./workspace-store');

function registerIpcHandlers() {
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

  ipcMain.handle('fs:read-dir', async (event, dirPath) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) return [];
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const results = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(dirPath, entry.name)
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
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:write-file', async (event, { filePath, content }) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:watch-file', (event, filePath) => {
    if (!filePath || fileWatchers.has(filePath)) return true;
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
      fileWatchers.set(filePath, watcher);
      return true;
    } catch (err) {
      console.error('fs:watch-file error:', err);
      return false;
    }
  });

  ipcMain.handle('fs:unwatch-file', (event, filePath) => {
    if (fileWatchers.has(filePath)) {
      try {
        fileWatchers.get(filePath).close();
      } catch (_) {}
      fileWatchers.delete(filePath);
    }
    return true;
  });
}

module.exports = { registerIpcHandlers };
