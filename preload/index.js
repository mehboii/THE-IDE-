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

  // Custom remote model configuration and streaming chat (main-process only)
  getCustomModels: () => ipcRenderer.invoke('custom-models:list'),
  saveCustomModels: (models) => ipcRenderer.invoke('custom-models:save', models),
  testCustomModel: (model) => ipcRenderer.invoke('custom-models:test', model),
  sendCustomModelChat: (payload) => ipcRenderer.invoke('custom-models:chat', payload),
  decideCustomModelTool: (callId, approved) => ipcRenderer.invoke('custom-models:tool-decision', { callId, approved }),
  onCustomModelToken: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:token', h); return () => ipcRenderer.removeListener('custom-model:token', h); },
  onCustomModelDone: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:done', h); return () => ipcRenderer.removeListener('custom-model:done', h); },
  onCustomModelError: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:error', h); return () => ipcRenderer.removeListener('custom-model:error', h); },
  onCustomModelToolCall: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:tool-call', h); return () => ipcRenderer.removeListener('custom-model:tool-call', h); },
  onCustomModelToolResult: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:tool-result', h); return () => ipcRenderer.removeListener('custom-model:tool-result', h); },
  onCustomModelMaxIterations: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('custom-model:max-iterations', h); return () => ipcRenderer.removeListener('custom-model:max-iterations', h); },
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

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
