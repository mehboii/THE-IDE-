const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // PTY Methods
  createPty: (params) => ipcRenderer.invoke('pty:create', params),
  writePty: (paneId, data) => ipcRenderer.send('pty:write', { paneId, data }),
  resizePty: (paneId, cols, rows) => ipcRenderer.send('pty:resize', { paneId, cols, rows }),
  destroyPty: (paneId, killTmux = false) => ipcRenderer.invoke('pty:destroy', { paneId, killTmux }),
  restartPty: (params) => ipcRenderer.invoke('pty:restart', params),

  // PTY Event Listeners
  onPtyData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('pty-data', handler);
    return () => ipcRenderer.removeListener('pty-data', handler);
  },
  onPtyExit: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('pty-exit', handler);
    return () => ipcRenderer.removeListener('pty-exit', handler);
  },

  // tmux Methods
  checkTmux: () => ipcRenderer.invoke('tmux:check'),
  listOrphans: () => ipcRenderer.invoke('tmux:list-orphans'),
  killTmuxSession: (sessionName) => ipcRenderer.invoke('tmux:kill-session', { sessionName }),
  killAllSessions: () => ipcRenderer.invoke('tmux:kill-all'),

  // Agent Preset Methods
  getAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgents: (agentsList) => ipcRenderer.invoke('agents:save', agentsList),

  // Workspace Storage Methods
  getWorkspaces: () => ipcRenderer.invoke('workspaces:get-all'),
  saveWorkspace: (name, layout) => ipcRenderer.invoke('workspaces:save', { name, layout }),
  loadWorkspace: (name) => ipcRenderer.invoke('workspaces:load', { name }),
  deleteWorkspace: (name) => ipcRenderer.invoke('workspaces:delete', { name }),

  // System Dialogs
  selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  showSaveDialog: (defaultPath) => ipcRenderer.invoke('dialog:show-save-dialog', defaultPath),
  setTestSaveAsPath: (targetPath) => ipcRenderer.invoke('test:set-save-as-path', targetPath),
  setTestDirectoryPath: (targetPath) => ipcRenderer.invoke('test:set-directory-path', targetPath),

  // Filesystem & Watcher Methods
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', { filePath, content }),
  watchFile: (filePath) => ipcRenderer.invoke('fs:watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('fs:unwatch-file', filePath),
  onFileChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },
  openEditorFile: (filePath) => ipcRenderer.invoke('editor:open-file', filePath)
});

contextBridge.exposeInMainWorld('__IDE_TEST_MODE__', process.env.IDE_TEST_MODE === '1');
