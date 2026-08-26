const fs = require('fs');
const path = require('path');

// The main process owns the active project root. Renderer state is a view of
// this value only; execution code must always resolve its default from here.
class ProjectRoot {
  constructor() { this.currentWorkspaceRoot = null; }

  get() { return this.currentWorkspaceRoot; }

  /**
   * The only cwd resolver used by process-launch paths.  It intentionally
   * never falls back to process.cwd(): Electron's packaged cwd is frequently
   * the installation directory, which must never become a project workspace.
   */
  resolveWorkingDirectory(candidate, purpose = 'process', preferOpenedFolder = true) {
    const requested = (preferOpenedFolder && this.currentWorkspaceRoot) || candidate;
    if (!requested || typeof requested !== 'string') {
      throw new Error(`Could not resolve working directory for ${purpose}: no opened folder is available.`);
    }

    try {
      const resolved = path.resolve(requested);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error('path does not exist or is not a directory');
      }
      // realpath handles Windows drive-letter and removable-media spelling
      // consistently while preserving the actual volume selected by the user.
      const canonical = fs.realpathSync(resolved);
      console.log(`[CWD RESOLUTION] ${purpose}: requested=${JSON.stringify(requested)} resolved=${JSON.stringify(resolved)} canonical=${JSON.stringify(canonical)}`);
      return canonical;
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      console.error(`[CWD RESOLUTION FAILED] ${purpose}: requested=${JSON.stringify(requested)} error=${detail}`);
      throw new Error(`Could not resolve working directory${requested ? ` "${requested}"` : ''} for ${purpose}: ${detail}`);
    }
  }

  set(root) {
    if (!root) { this.currentWorkspaceRoot = null; return null; }
    this.currentWorkspaceRoot = this.resolveWorkingDirectory(root, 'opened folder', false);
    return this.currentWorkspaceRoot;
  }
}

module.exports = new ProjectRoot();
