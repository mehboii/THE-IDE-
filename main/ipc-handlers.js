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
}

module.exports = { registerIpcHandlers };
