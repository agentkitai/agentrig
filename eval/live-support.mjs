// Trusted evaluator helpers. No credentials or network access in task workers.
import { execFile, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export const BUDGET = Object.freeze({ maxTurns: 24, maxTokens: 200_000, maxMinutes: 5 });
export const TOTAL_TOKENS = 10_000_000;
// Scheduling reserve only, never reported as measured usage or a guaranteed billing bound.
export const UNKNOWN_RESERVE = 1_178_000;
export function schedule() {
  return Array.from({ length: 3 }, (_, repeat) =>
    ['A1', 'A2', 'A3', 'A4', 'X1', 'X2', 'X3', 'X4'].flatMap((task, index) =>
      Array.from({ length: 4 }, (_, position) => {
        const config = (position + index + repeat) % 4;
        return { task, repeat: repeat + 1, position, supervisor: !!(config & 2), memory: !!(config & 1) };
      }))).flat();
}
export function guard(ledger) {
  if (ledger.blocked) throw new Error(`BLOCKED: ${ledger.blocked}`);
  if (ledger.tokens + (ledger.unknownCalls ?? 0) * UNKNOWN_RESERVE >= TOTAL_TOKENS) throw new Error('BLOCKED: total reported-token/reserve guard reached');
  if ((ledger.unknownCalls ?? 0) >= 3) throw new Error('BLOCKED: three incomplete provider calls; reconcile before continuing');
  if (Date.now() - ledger.startedAt >= 12 * 60 * 60_000) throw new Error('BLOCKED: experiment wall-time guard reached');
}
export function command(program, args, options = {}) {
  if (options.ownedTree === true) return ownedCommand(program, args, options);
  return new Promise(resolve => execFile(program, args, { encoding: 'utf8', timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', ...options }, (error, stdout, stderr) => resolve({
      code: error ? typeof error.code === 'number' ? error.code : null : 0,
      infrastructure: !!error && (typeof error.code !== 'number' || error.signal != null),
      stdout, stderr, error: error?.message ?? null,
    })));
}
// Explicitly owned preparation subprocess trees only. Production R9b execution is Linux-only;
// the portable test transport also exercises normal completion on macOS/Windows.
function ownedCommand(program, args, options) {
  const { signal, timeout = 120_000, ownedTree: _ownedTree, ...rest } = options;
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ code: null, infrastructure: true, stdout: '', stderr: '', error: 'cancelled' });
    let interrupted = false;
    // execFile does not forward detached to spawn; use the actual spawn group option.
    const child = spawn(program, args, { ...rest, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let bytes = 0, spawnError = null;
    const capture = chunks => data => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) stop();
      else chunks.push(data);
    };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      resolve({ code, infrastructure: interrupted || spawnError !== null || childSignal !== null,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        error: interrupted ? 'cancelled, timed out or output exceeded limit' : spawnError?.message ?? null });
    });
    const stop = () => {
      interrupted = true;
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000, windowsHide: true }, () => {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } }
      }
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
export function dockerArgs({ name, image, workspace, checkerReceipt, network = false }) {
  if (!/^agentrig-e3-[a-f0-9-]+$/.test(name)) throw new Error('invalid owned container name');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('image must be pinned by ID');
  for (const path of [workspace, checkerReceipt].filter(Boolean)) {
    if (!isAbsolute(path) || /[,\n\r]/.test(path)) throw new Error('invalid mount path');
  }
  return ['run', '--pull=never', '--rm', '--name', name, '--network', network ? 'bridge' : 'none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=128',
    '--memory=4g', '--cpus=2', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '-e', 'HOME=/tmp/e3-home',
    '--mount', `type=bind,src=${workspace},dst=/workspace`,
    ...(checkerReceipt ? ['--mount', `type=bind,src=${checkerReceipt},dst=/receipt.json,readonly`] : []),
    '--workdir', '/workspace', image];
}
export async function dockerRun(options, args, signal, timeout = 120_000) {
  const name = `agentrig-e3-${randomUUID()}`;
  const argv = dockerArgs({ ...options, name });
  try { return { ...await command('docker', [...argv, ...args], { signal, timeout }), containerName: name }; }
  finally {
    // Exact UUID generated by this call; never touches pre-existing/user containers or volumes.
    await command('docker', ['rm', '--force', name], { timeout: 10_000 });
  }
}
export async function digestTree(root) {
  const hash = createHash('sha256');
  async function visit(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), relative = `${prefix}${name}`;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path, `${relative}/`);
      else if (stat.isFile()) {
        const bytes = await readFile(path);
        hash.update(`${relative.length}:${relative}:${bytes.length}:`).update(bytes);
      } else throw new Error(`nonregular corpus entry: ${relative}`);
    }
  }
  await visit(root, '');
  return hash.digest('hex');
}
