const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const projectRoot = require('./project-root');

const execAsync = promisify(exec);

const TOOL_SCHEMA = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 file from the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a UTF-8 file in the project.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_directory', description: 'List files and folders in the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a project-scoped shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } } }
];

// Tool calls use the same opened-folder root as Explorer and PTY spawning.
function rootFor(cwd) {
  const pr = projectRoot.get();
  if (pr) return pr;
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd);
  throw new Error('No project directory opened. Please open a folder first.');
}
function inside(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function resolvedPath(root, requested = '.') {
  if (typeof requested !== 'string') throw new Error('Path must be a string.');
  let target;
  if (path.isAbsolute(requested)) {
    target = path.resolve(requested);
  } else {
    target = path.resolve(root, requested);
  }
  if (!inside(root, target)) {
    throw new Error(`Path "${requested}" resolves outside project root "${root}" and was rejected.`);
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
function title(name, args) {
  if (name === 'read_file') return `Reading ${args.path}`;
  if (name === 'write_file') return `Writing ${args.path}`;
  if (name === 'list_directory') return `Listing ${args.path || '.'}`;
  return `Running ${args.command}`;
}
async function executeTool(name, args, cwd) {
  const root = rootFor(cwd);
  try {
    await fs.access(root);
    if (name === 'read_file') { const file = resolvedPath(root, args.path); await realPathInside(root, file); return { ok: true, content: await fs.readFile(file, 'utf8') }; }
    if (name === 'list_directory') { const dir = resolvedPath(root, args.path || '.'); await realPathInside(root, dir); const entries = await fs.readdir(dir, { withFileTypes: true }); return { ok: true, entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })) }; }
    if (name === 'write_file') {
      const file = resolvedPath(root, args.path);
      console.log(`[FS WRITE ASSERTION] Resolving write path: ${file} against root: ${root}`);
      try { await realPathInside(root, file); } catch (error) { if (error.code !== 'ENOENT') throw error; await realPathInside(root, path.dirname(file), true); }
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, String(args.content ?? ''), 'utf8'); return { ok: true, message: `Wrote ${path.relative(root, file)}` };
    }
    if (name === 'run_command') {
      const blocked = destructiveCommand(args.command); if (blocked) return { ok: false, error: blocked };
      const commandCwd = resolvedPath(root, args.cwd || '.'); await realPathInside(root, commandCwd);
      console.log(`[EXEC ASSERTION] Running command: ${args.command} in cwd: ${commandCwd}`);
      try { const result = await execAsync(String(args.command), { cwd: commandCwd, timeout: 30_000, maxBuffer: 1024 * 1024, shell: '/bin/zsh' }); return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }; }
      catch (error) { return { ok: false, stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: Number.isInteger(error.code) ? error.code : 1 }; }
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) { return { ok: false, error: error.message }; }
}

module.exports = { TOOL_SCHEMA, executeTool, title };
