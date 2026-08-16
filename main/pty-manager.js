const { spawn } = require('node-pty');
const { execFile } = require('child_process');
const fs = require('fs');
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

  async createSession({ paneId, cwd, agentCommand = '', envVars = {}, customSessionName, cols = 80, rows = 24, forceNew = false }) {
    if (!paneId) throw new Error('paneId is required');
    await this.destroySession(paneId, false);

    // A pane may deliberately retain its own cwd, but a newly-created pane
    // defaults to the one main-process project root shared with the explorer.
    const requestedCwd = cwd || projectRoot.get();
    const safeCwd = requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory() ? requestedCwd : process.cwd();
    const tmux = await this.checkTmuxAvailable();

    // Fallback mode when tmux is not installed / not on PATH
    if (!tmux.available) {
      const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
      const args = [];
      if (agentCommand.trim()) {
        args.push('-lc', `${agentCommand}; exec "${shell}" -l`);
      } else {
        args.push('-l');
      }

      let ptyProcess;
      try {
        ptyProcess = spawn(shell, args, {
          name: 'xterm-256color',
          cols: Math.max(2, cols),
          rows: Math.max(2, rows),
          cwd: safeCwd,
          env: { ...process.env, ...envVars, TERM: 'xterm-256color' }
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

    // forceNew: kill any leftover tmux session so we never reattach to a dead one
    if (forceNew) {
      await this.killTmuxSession(sessionName).catch(() => {});
    }

    const args = ['new-session', '-A', '-s', sessionName, '-c', safeCwd];
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
