const fs = require('fs');
const path = require('path');

function diagnosticLog(line) {
  console.log(line);
  // Packaged apps usually have no visible parent console. Keep the exact
  // spawn/root trace in a durable per-user log as well.
  try {
    const { app } = require('electron');
    if (app?.isReady?.()) {
      fs.appendFileSync(path.join(app.getPath('userData'), 'process-cwd.log'), `${new Date().toISOString()} ${line}\n`);
    }
  } catch (_) { /* diagnostics must never prevent a launch */ }
}

// The main process owns the active project root. Renderer state is a view of
// this value only; execution code must always resolve its default from here.
class ProjectRoot {
  constructor() { this.currentWorkspaceRoot = null; }

  get() { return this.currentWorkspaceRoot; }

  /**
   * Resolve a working directory for spawned processes. When no project folder is
   * opened yet, refuse to spawn. Falling back to Electron's app path or the
   * process cwd is unsafe: it is how a terminal could silently start in the
   * IDE checkout/install directory instead of the folder selected by the user.
   */
  resolveWorkingDirectory(candidate, purpose = 'process', preferOpenedFolder = true) {
    // `candidate` is accepted only for the Open Folder assignment itself.
    // Spawn callers cannot substitute a pane-local path when no folder is open.
    const requested = preferOpenedFolder ? this.currentWorkspaceRoot : candidate;
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
    // Permanent trace point: this is the only state transition that changes
    // the execution root for PTYs, Runner, and model tools.
    diagnosticLog(`[OPENED FOLDER] Project root assigned: ${JSON.stringify(this.currentWorkspaceRoot)}`);
    return this.currentWorkspaceRoot;
  }

  assertSpawnCwd(resolvedCwd, action) {
    const expected = this.currentWorkspaceRoot;
    if (!expected || resolvedCwd !== expected) {
      const message = `Blocked ${action}: resolved cwd ${JSON.stringify(resolvedCwd)} does not match opened folder ${JSON.stringify(expected)}.`;
      diagnosticLog(`[CWD MISMATCH] ${message}`);
      throw new Error(message);
    }
    diagnosticLog(`[PROCESS SPAWN] action=${action} cwd=${JSON.stringify(resolvedCwd)} openedFolder=${JSON.stringify(expected)}`);
    return resolvedCwd;
  }
}

module.exports = new ProjectRoot();
