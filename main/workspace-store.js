const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class WorkspaceStore {
  constructor() {
    this.storePath = path.join(app.getPath('userData'), 'workspaces.json');
  }

  _readAll() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, { encoding: 'utf8' });
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[WorkspaceStore] Error reading workspaces store:', err);
    }
    return { workspaces: {}, activeWorkspace: null };
  }

  _writeAll(data) {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[WorkspaceStore] Error writing workspace store:', err);
      return false;
    }
  }

  getWorkspaces() {
    const data = this._readAll();
    return data.workspaces || {};
  }

  saveWorkspace(name, workspaceData) {
    const data = this._readAll();
    data.workspaces = data.workspaces || {};
    data.workspaces[name] = {
      ...workspaceData,
      updatedAt: new Date().toISOString()
    };
    data.activeWorkspace = name;
    this._writeAll(data);
    return true;
  }

  loadWorkspace(name) {
    const workspaces = this.getWorkspaces();
    return workspaces[name] || null;
  }

  deleteWorkspace(name) {
    const data = this._readAll();
    if (data.workspaces && data.workspaces[name]) {
      delete data.workspaces[name];
      if (data.activeWorkspace === name) {
        data.activeWorkspace = null;
      }
      this._writeAll(data);
      return true;
    }
    return false;
  }
}

module.exports = new WorkspaceStore();
