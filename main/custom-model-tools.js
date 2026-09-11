const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const projectRoot = require('./project-root');

const execAsync = promisify(exec);

const TOOL_SCHEMA = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 file from the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a UTF-8 file in the project.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'create_file', description: 'Create or overwrite a UTF-8 file in the project.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_directory', description: 'List files and folders in the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a project-scoped shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } } }
];

function normalizeArgString(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null) {
    if (typeof val.value === 'string') return val.value;
    if (typeof val.content === 'string') return val.content;
    if (typeof val.path === 'string') return val.path;
    if (typeof val.command === 'string') return val.command;
  }
  return String(val);
}

// Tool calls use the same opened-folder root as Explorer and PTY spawning.
function rootFor(cwd) {
  return projectRoot.resolveWorkingDirectory(cwd, 'model tool');
}
function inside(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function resolvedPath(root, requested = '.') {
  const norm = normalizeArgString(requested) || '.';
  let target;
  if (path.isAbsolute(norm)) {
    target = path.resolve(norm);
  } else {
    target = path.resolve(root, norm);
  }
  if (!inside(root, target)) {
    throw new Error(`Path "${norm}" resolves outside project root "${root}" and was rejected.`);
  }
  return target;
}
async function realPathInside(root, target, allowMissing = false) {
  let probe = target;
  while (allowMissing) { try { await fs.lstat(probe); break; } catch { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; } }
  const real = await fs.realpath(probe);
  const realRoot = await fs.realpath(root);
  if (!inside(realRoot, real)) throw new Error('Path resolves outside the project root and was rejected.');
}
function destructiveCommand(command) {
  const value = String(command || '');
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(value)) return 'Fork bomb pattern is blocked.';
  if (/\brm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+(?:\/|~)(?:\s|$)/.test(value)) return 'Destructive removal of / or ~ is blocked.';
  // Commands are deliberately conservative: absolute/home/traversal targets
  // could escape cwd through shell semantics and are never run.
  if (/(?:^|[\s;&|'"])(?:\/|~\/|\.\.\/)/.test(value)) return 'Commands targeting paths outside the project root are blocked.';
  return null;
}
function title(name, rawArgs) {
  const p = normalizeArgString(rawArgs?.path);
  const cmd = normalizeArgString(rawArgs?.command);
  if (name === 'read_file') return `Reading ${p}`;
  if (name === 'write_file' || name === 'create_file') return `Writing ${p}`;
  if (name === 'list_directory') return `Listing ${p || '.'}`;
  return `Running ${cmd}`;
}
async function executeTool(name, rawArgs, cwd) {
  const root = rootFor(cwd);
  const args = {};
  if (rawArgs && typeof rawArgs === 'object') {
    for (const [k, v] of Object.entries(rawArgs)) {
      args[k] = normalizeArgString(v);
    }
  }
  try {
    await fs.access(root);
    if (name === 'read_file') {
      const file = resolvedPath(root, args.path);
      projectRoot.logToolPath('read_file', file);
      await realPathInside(root, file);
      return { success: true, ok: true, path: args.path, content: await fs.readFile(file, { encoding: 'utf8' }) };
    }
    if (name === 'list_directory') {
      const dir = resolvedPath(root, args.path || '.');
      projectRoot.logToolPath('list_directory', dir);
      await realPathInside(root, dir);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { success: true, ok: true, path: args.path || '.', entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })) };
    }
    if (name === 'write_file' || name === 'create_file') {
      const file = resolvedPath(root, args.path);
      projectRoot.logToolPath(name, file);
      try { await realPathInside(root, file); } catch (error) { if (error.code !== 'ENOENT') throw error; await realPathInside(root, path.dirname(file), true); }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return { success: true, ok: true, path: args.path, message: `File created successfully at ${path.relative(root, file)}` };
    }
    if (name === 'run_command') {
      const blocked = destructiveCommand(args.command);
      if (blocked) return { success: false, ok: false, error: blocked };
      const commandCwd = resolvedPath(root, args.cwd || '.');
      projectRoot.logToolPath('run_command', commandCwd);
      await realPathInside(root, commandCwd);
      projectRoot.assertSpawnCwd(commandCwd, 'custom-model:run_command');
      try {
        const result = await execAsync(String(args.command), { cwd: commandCwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
        return { success: true, ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        return { success: false, ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: Number.isInteger(error.code) ? error.code : 1 };
      }
    }
    return { success: false, ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { success: false, ok: false, error: error.message };
  }
}

module.exports = { TOOL_SCHEMA, executeTool, title, normalizeArgString };
