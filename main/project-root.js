const fs = require('fs');
const path = require('path');

// The main process owns the active project root. Renderer state is a view of
// this value only; execution code must always resolve its default from here.
class ProjectRoot {
  constructor() { this.currentWorkspaceRoot = null; }

  get() { return this.currentWorkspaceRoot; }

  set(root) {
    if (!root) { this.currentWorkspaceRoot = null; return null; }
    const resolved = path.resolve(root);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('Project root must be an existing directory.');
    }
    this.currentWorkspaceRoot = resolved;
    return resolved;
  }
}

module.exports = new ProjectRoot();
