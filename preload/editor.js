const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  showSaveDialog: (defaultPath) => ipcRenderer.invoke('dialog:show-save-dialog', defaultPath),
  setTestSaveAsPath: (targetPath) => ipcRenderer.invoke('test:set-save-as-path', targetPath),
  setTestDirectoryPath: (targetPath) => ipcRenderer.invoke('test:set-directory-path', targetPath),
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
  onEditorOpenFile: (callback) => {
    const handler = (event, filePath) => callback(filePath);
    ipcRenderer.on('editor:open-file', handler);
    return () => ipcRenderer.removeListener('editor:open-file', handler);
  }
});

contextBridge.exposeInMainWorld('__IDE_TEST_MODE__', process.env.IDE_TEST_MODE === '1');
