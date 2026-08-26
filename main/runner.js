const { spawn, execSync } = require('child_process');
const { shell } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const projectRoot = require('./project-root');

class RunnerManager {
  constructor() {
    this.activeRuns = new Map(); // runId -> { process, cdpWs, mode, filePath }
    this.runIdCounter = 1;
  }

  async findFreePort(startPort = 9229) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(startPort, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        resolve(this.findFreePort(startPort + 1));
      });
    });
  }

  getWorkingDir(filePath) {
    const candidate = filePath && path.isAbsolute(filePath) ? path.dirname(filePath) : null;
    return projectRoot.resolveWorkingDirectory(candidate, 'Run/Debug process');
  }

  async execute(webContents, { filePath, mode = 'run', breakpoints = [] }) {
    if (!filePath) {
      return { success: false, message: 'No active file to run.' };
    }

    const ext = path.extname(filePath).toLowerCase();
    let cwd;
    try {
      cwd = this.getWorkingDir(filePath);
    } catch (error) {
      return { success: false, message: error.message };
    }
    const fileName = path.basename(filePath);

    // 1. HTML -> Open in default browser
    if (ext === '.html' || ext === '.htm') {
      try {
        const fileUrl = filePath.startsWith('file://') ? filePath : `file://${path.resolve(filePath)}`;
        await shell.openExternal(fileUrl);
        return { success: true, isNotice: true, message: `Opened ${fileName} in default browser.` };
      } catch (err) {
        return { success: false, message: `Failed to open browser: ${err.message}` };
      }
    }

    // 2. Debug for non-JS languages -> Show notice
    if (mode === 'debug' && ext !== '.js' && ext !== '.mjs') {
      return {
        success: false,
        isNotice: true,
        message: `Debugging not yet supported for this file type (${ext}) — Run Without Debugging is available.`
      };
    }

    // 3. Command determination
    let command = '';
    let args = [];

    if (ext === '.js' || ext === '.mjs') {
      command = 'node';
      if (mode === 'debug') {
        const port = await this.findFreePort(9229);
        args = [`--inspect-brk=${port}`, filePath];
        return this.startDebugRun(webContents, { filePath, command, args, cwd, port, breakpoints });
      } else {
        args = [filePath];
      }
    } else if (ext === '.py') {
      command = 'python3';
      args = [filePath];
    } else if (ext === '.ts') {
      // Check if ts-node is available
      let hasTsNode = false;
      try {
        execSync('ts-node -v', { stdio: 'ignore' });
        hasTsNode = true;
      } catch (_) {
        try {
          execSync('npx --no-install ts-node -v', { stdio: 'ignore' });
          command = 'npx';
          args = ['ts-node', filePath];
          hasTsNode = true;
        } catch (_) {}
      }
      if (!hasTsNode) {
        return {
          success: false,
          message: 'ts-node/tsc is not installed. Please install ts-node to run TypeScript files.'
        };
      }
      if (!command) {
        command = 'ts-node';
        args = [filePath];
      }
    } else {
      return {
        success: false,
        message: `No run configuration for this file type (${ext || 'no extension'}).`
      };
    }

    // Standard Run / Run Without Debugging execution
    const runId = `run-${this.runIdCounter++}`;
    console.log(`[RUNNER ASSERTION] Spawning process '${command} ${args.join(' ')}' with cwd: ${cwd}`);

    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' } });
    } catch (err) {
      return { success: false, message: `Failed to spawn process: ${err.message}` };
    }

    this.activeRuns.set(runId, { process: child, mode: 'run', filePath });

    child.stdout.on('data', (data) => {
      if (!webContents.isDestroyed()) {
        webContents.send('runner:data', { runId, text: data.toString('utf8'), stream: 'stdout' });
      }
    });

    child.stderr.on('data', (data) => {
      if (!webContents.isDestroyed()) {
        webContents.send('runner:data', { runId, text: data.toString('utf8'), stream: 'stderr' });
      }
    });

    child.on('exit', (exitCode, signal) => {
      this.activeRuns.delete(runId);
      if (!webContents.isDestroyed()) {
        webContents.send('runner:exit', { runId, exitCode: exitCode ?? (signal ? 1 : 0), signal });
      }
    });

    return { success: true, runId, label: `Output: ${fileName}` };
  }

  async startDebugRun(webContents, { filePath, command, args, cwd, port, breakpoints }) {
    const runId = `debug-${this.runIdCounter++}`;
    const fileName = path.basename(filePath);
    console.log(`[DEBUG ASSERTION] Spawning debug process '${command} ${args.join(' ')}' on port ${port} with cwd: ${cwd}`);

    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' } });
    } catch (err) {
      return { success: false, message: `Failed to spawn debug process: ${err.message}` };
    }

    const runInfo = { process: child, mode: 'debug', filePath, port, cdpWs: null };
    this.activeRuns.set(runId, runInfo);

    child.stdout.on('data', (data) => {
      if (!webContents.isDestroyed()) {
        webContents.send('runner:data', { runId, text: data.toString('utf8'), stream: 'stdout' });
      }
    });

    child.stderr.on('data', (data) => {
      if (!webContents.isDestroyed()) {
        webContents.send('runner:data', { runId, text: data.toString('utf8'), stream: 'stderr' });
      }
    });

    child.on('exit', (exitCode, signal) => {
      if (runInfo.cdpWs) {
        try { runInfo.cdpWs.close(); } catch (_) {}
      }
      this.activeRuns.delete(runId);
      if (!webContents.isDestroyed()) {
        webContents.send('runner:exit', { runId, exitCode: exitCode ?? (signal ? 1 : 0), signal });
      }
    });

    // Wait for inspector WebSocket URL
    const wsUrl = await this.getInspectorWsUrl(port);
    if (!wsUrl) {
      child.kill();
      return { success: false, message: `Debugger failed to start on port ${port}.` };
    }

    this.connectCdpWebSocket(webContents, runId, runInfo, wsUrl, filePath, breakpoints);

    return { success: true, runId, label: `Debug: ${fileName}` };
  }

  getInspectorWsUrl(port, retries = 30) {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const targets = JSON.parse(body);
              if (targets && targets[0] && targets[0].webSocketDebuggerUrl) {
                return resolve(targets[0].webSocketDebuggerUrl);
              }
            } catch (_) {}
            if (attempts < retries) setTimeout(check, 100);
            else resolve(null);
          });
        }).on('error', () => {
          if (attempts < retries) setTimeout(check, 100);
          else resolve(null);
        });
      };
      check();
    });
  }

  connectCdpWebSocket(webContents, runId, runInfo, wsUrl, filePath, breakpoints) {
    const WebSocketClient = globalThis.WebSocket || require('ws');
    const ws = new WebSocketClient(wsUrl);
    runInfo.cdpWs = ws;
    let msgId = 1;
    const pendingCallbacks = new Map();

    const sendCdp = (method, params = {}) => {
      return new Promise((resolve) => {
        const id = msgId++;
        pendingCallbacks.set(id, resolve);
        if (ws.readyState === 1) { // OPEN
          ws.send(JSON.stringify({ id, method, params }));
        } else {
          resolve({ error: 'WS not open' });
        }
      });
    };

    ws.onopen = async () => {
      console.log(`[CDP] Connected to inspector WebSocket at ${wsUrl}`);
      await sendCdp('Debugger.enable');
      await sendCdp('Runtime.enable');

      // Set breakpoints
      if (Array.isArray(breakpoints) && breakpoints.length > 0) {
        for (const line of breakpoints) {
          // Monaco line numbers are 1-based, CDP line numbers are 0-based
          await sendCdp('Debugger.setBreakpointByUrl', {
            lineNumber: Math.max(0, line - 1),
            urlRegex: '.*'
          });
        }
      }

      // Resume execution from initial --inspect-brk break
      await sendCdp('Debugger.resume');
    };

    ws.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data || event);
      } catch (_) { return; }

      if (data.id && pendingCallbacks.has(data.id)) {
        const cb = pendingCallbacks.get(data.id);
        pendingCallbacks.delete(data.id);
        cb(data.result);
        return;
      }

      if (data.method === 'Debugger.paused') {
        const params = data.params || {};
        const topFrame = params.callFrames?.[0];
        let currentLine = 1;
        let vars = [];

        if (topFrame) {
          currentLine = (topFrame.location?.lineNumber ?? 0) + 1;
          // Inspect scope variables (Local)
          const localScope = topFrame.scopeChain?.find(s => s.type === 'local');
          if (localScope && localScope.object?.objectId) {
            const propsRes = await sendCdp('Runtime.getProperties', {
              objectId: localScope.object.objectId,
              ownProperties: true
            });
            if (propsRes && propsRes.result) {
              vars = propsRes.result
                .filter(p => p.name !== 'exports' && p.name !== 'require' && p.name !== 'module' && p.name !== '__filename' && p.name !== '__dirname')
                .map(p => ({
                  name: p.name,
                  value: p.value?.value !== undefined ? String(p.value.value) : (p.value?.description || 'undefined'),
                  type: p.value?.type || 'unknown'
                }));
            }
          }
        }

        if (!webContents.isDestroyed()) {
          webContents.send('runner:debug-paused', {
            runId,
            lineNumber: currentLine,
            reason: params.reason || 'breakpoint',
            callFrames: (params.callFrames || []).map(f => ({
              functionName: f.functionName || '(anonymous)',
              lineNumber: (f.location?.lineNumber ?? 0) + 1,
              url: f.url
            })),
            variables: vars
          });
        }
      } else if (data.method === 'Debugger.resumed') {
        if (!webContents.isDestroyed()) {
          webContents.send('runner:debug-resumed', { runId });
        }
      }
    };

    ws.onerror = (err) => {
      console.warn(`[CDP] WebSocket error:`, err);
    };
  }

  sendDebugCommand(runId, command) {
    const runInfo = this.activeRuns.get(runId);
    if (!runInfo || !runInfo.cdpWs || runInfo.cdpWs.readyState !== 1) return false;

    let cdpMethod = 'Debugger.resume';
    if (command === 'stepOver') cdpMethod = 'Debugger.stepOver';
    else if (command === 'stepInto') cdpMethod = 'Debugger.stepInto';
    else if (command === 'stepOut') cdpMethod = 'Debugger.stepOut';
    else if (command === 'resume') cdpMethod = 'Debugger.resume';

    runInfo.cdpWs.send(JSON.stringify({ id: 9999, method: cdpMethod, params: {} }));
    return true;
  }

  stop(runId) {
    const runInfo = this.activeRuns.get(runId);
    if (!runInfo) return false;

    if (runInfo.cdpWs) {
      try { runInfo.cdpWs.close(); } catch (_) {}
    }

    if (runInfo.process && !runInfo.process.killed) {
      try { runInfo.process.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        if (runInfo.process && !runInfo.process.killed) {
          try { runInfo.process.kill('SIGKILL'); } catch (_) {}
        }
      }, 500);
    }

    this.activeRuns.delete(runId);
    return true;
  }
}

module.exports = new RunnerManager();
