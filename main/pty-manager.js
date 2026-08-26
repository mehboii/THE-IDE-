const { spawn } = require('node-pty');
const { execFile } = require('child_process');
const projectRoot = require('./project-root');

const TMUX_PREFIX = 'ide-';

function runTmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', error: stderr || (error && error.message) || '' });
    });
  });
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.window = null;
  }

  setWindow(window) { this.window = window; }

  sessionName(paneId, customSessionName) {
    const name = customSessionName || `${TMUX_PREFIX}${paneId}`;
    if (!/^ide-[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid tmux session name');
    return name;
  }

  async checkTmuxAvailable() {
    const result = await runTmux(['-V']);
    return { available: result.ok, version: result.ok ? result.stdout.trim() : null, error: result.error };
  }

  async createSession({ paneId, cwd, agentCommand = '', envVars = {}, customSessionName, cols = 80, rows = 24, forceNew = true }) {
    if (!paneId) throw new Error('paneId is required');
    await this.destroySession(paneId, false);

    // Once a folder is open, it is the sole cwd authority for every spawn.
    // Renderer pane state cannot override the Explorer's project root.
    const safeCwd = projectRoot.resolveWorkingDirectory(cwd, `PTY session ${paneId}`);
    console.log(`[PTY CWD ASSERTION] Spawning PTY session ${paneId} with cwd: ${JSON.stringify(safeCwd)} (projectRoot: ${JSON.stringify(projectRoot.get())})`);
    const tmux = await this.checkTmuxAvailable();

    // Fallback mode when tmux is not installed / not on PATH
    if (!tmux.available) {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/sh');
      // node-pty's cwd is not consistently applied by Windows PowerShell
      // (it can start at System32). Establish the canonical cwd in PowerShell
      // itself as well, using -LiteralPath so spaces and [] are never parsed.
      const powerShellCwdCommand = `Set-Location -LiteralPath '${safeCwd.replace(/'/g, "''")}'`;
      // PowerShell/cmd do not support the POSIX `-lc` and `-l` flags. Keep
      // the agent command interactive on Windows, then leave the shell open.
      const args = isWindows
        ? ['/NoLogo', '-NoExit', '-Command', agentCommand.trim()
          ? `${powerShellCwdCommand}; ${agentCommand}`
          : powerShellCwdCommand]
        : (agentCommand.trim()
          ? ['-lc', `${agentCommand}; exec "${shell}" -l`]
          : ['-l']);

      let ptyProcess;
      try {
        ptyProcess = spawn(shell, args, {
          name: isWindows ? 'xterm' : 'xterm-256color',
          cols: Math.max(2, cols),
          rows: Math.max(2, rows),
          cwd: safeCwd,
          env: { ...process.env, ...envVars, ...(isWindows ? {} : { TERM: 'xterm-256color' }) }
        });
      } catch (err) {
        throw new Error(`Failed to spawn fallback PTY for ${paneId}: ${err.message}`);
      }

      this.sessions.set(paneId, { ptyProcess, sessionName: null, isFallback: true });
      ptyProcess.onData((data) => this.send('pty-data', { paneId, data }));
      ptyProcess.onExit(({ exitCode }) => {
        if (this.sessions.get(paneId)?.ptyProcess === ptyProcess) this.sessions.delete(paneId);
        this.send('pty-exit', { paneId, exitCode, status: 'detached' });
      });

      return { paneId, sessionName: null, cwd: safeCwd, isFallback: true };
    }

    // Normal tmux-backed session
    const sessionName = this.sessionName(paneId, customSessionName);

    // A new pane must never attach to an old fixed-name tmux session: tmux then
    // retains that session's original cwd, even though `-c safeCwd` is supplied.
    // Existing-session restoration is handled explicitly by the orphan-session
    // UI, which passes forceNew:false when it truly intends to reattach.
    if (forceNew) {
      await this.killTmuxSession(sessionName).catch(() => {});
    }

    const args = forceNew
      ? ['new-session', '-s', sessionName, '-c', safeCwd]
      : ['new-session', '-A', '-s', sessionName, '-c', safeCwd];
    if (agentCommand.trim()) {
      args.push('/bin/sh', '-lc', `${agentCommand}; exec "${process.env.SHELL || '/bin/sh'}" -l`);
    }

    let ptyProcess;
    try {
      ptyProcess = spawn('tmux', args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(2, rows),
        cwd: safeCwd,
        env: { ...process.env, ...envVars, TERM: 'xterm-256color' }
      });
    } catch (err) {
      throw new Error(`Failed to spawn PTY for ${paneId}: ${err.message}`);
    }

    this.sessions.set(paneId, { ptyProcess, sessionName, isFallback: false });
    ptyProcess.onData((data) => this.send('pty-data', { paneId, data }));
    ptyProcess.onExit(({ exitCode }) => {
      if (this.sessions.get(paneId)?.ptyProcess === ptyProcess) this.sessions.delete(paneId);
      this.send('pty-exit', { paneId, exitCode, status: 'detached' });
    });

    return { paneId, sessionName, cwd: safeCwd, isFallback: false };
  }

  send(channel, payload) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  write(paneId, data) { this.sessions.get(paneId)?.ptyProcess.write(data); }
  resize(paneId, cols, rows) {
    const p = this.sessions.get(paneId)?.ptyProcess;
    if (p && cols > 1 && rows > 1) p.resize(cols, rows);
  }
  destroySession(paneId, killTmux = false) {
    const entry = this.sessions.get(paneId);
    if (entry) { try { entry.ptyProcess.kill(); } catch (_) {} this.sessions.delete(paneId); }
    return killTmux && entry && entry.sessionName ? this.killTmuxSession(entry.sessionName) : Promise.resolve({ ok: true });
  }
  async listOrphanSessions() {
    const tmux = await this.checkTmuxAvailable();
    if (!tmux.available) return [];
    const result = await runTmux(['list-sessions', '-F', '#S']);
    if (!result.ok) return [];
    const attached = new Set([...this.sessions.values()].map((s) => s.sessionName).filter(Boolean));
    return result.stdout.split(/\r?\n/).filter((name) => /^ide-[A-Za-z0-9_-]+$/.test(name) && !attached.has(name));
  }
  async killTmuxSession(sessionName) {
    if (!sessionName) return { ok: true };
    if (!/^ide-[A-Za-z0-9_-]+$/.test(sessionName)) throw new Error('Invalid tmux session name');
    for (const [paneId, entry] of this.sessions) if (entry.sessionName === sessionName) this.destroySession(paneId, false);
    return runTmux(['kill-session', '-t', sessionName]);
  }
  async killAllTmuxSessions() {
    const result = await runTmux(['list-sessions', '-F', '#S']);
    const names = result.ok ? result.stdout.split(/\r?\n/).filter((name) => /^ide-[A-Za-z0-9_-]+$/.test(name)) : [];
    await Promise.all(names.map((name) => this.killTmuxSession(name)));
    return { ok: true, killed: names };
  }
}

module.exports = new PtyManager();
