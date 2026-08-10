const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const ptyManager = require('./pty-manager');
const { registerIpcHandlers } = require('./ipc-handlers');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Agent Terminal IDE',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  ptyManager.setWindow(mainWindow);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.env.IDE_TEST_MODE) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Native menu mirrors in-app File/Terminal/View actions (VS Code-style)
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Pane',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.createPane({})');
            }
          }
        },
        {
          label: 'Save Workspace',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.saveCurrentWorkspace()');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Kill All Sessions',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.killAllSessions()');
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Toggle Broadcast',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.broadcastManager && window.broadcastManager.toggle()');
            }
          }
        },
        {
          label: 'Close Focused Pane',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                'window.appInstance && window.appInstance.focusedPaneId && window.appInstance.removePane(window.appInstance.focusedPaneId)'
              );
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.openCommandPalette()');
            }
          }
        },
        {
          label: 'Toggle Side Bar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.toggleSidebar()');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                'window.appInstance && window.appInstance.modalHelp && window.appInstance.modalHelp.classList.remove("hidden")'
              );
            }
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
