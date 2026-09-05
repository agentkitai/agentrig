// Explicit evaluator tool, not a product CLI. Only exports trusted, pinned repository trees.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, lstat, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { taskFor, seedText } from './tasks.mjs';

const git = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, ...options,
});

export async function prepare(id, source, destination) {
  const task = taskFor(id);
  const src = await realpath(source);
  const dest = resolve(destination);
  const parent = await realpath(dirname(dest));
  if (parent !== dirname(dest)) throw new Error('destination parent must be canonical, not a symlink');
  // Validate the pin before creating anything; dirty source files are never read or reset.
  if (git(src, ['rev-parse', `${task.revision}^{commit}`]).trim() !== task.revision) throw new Error('wrong revision');
  const archive = git(src, ['archive', '--format=tar', task.revision], { encoding: 'buffer' });
  const receiptPath = `${dest}.receipt.json`;
  // The external receipt is claimed first. Failure preserves artifacts for inspection, never cleanup guesses.
  const receiptHandle = await open(receiptPath, 'wx', 0o600);
  try {
    await mkdir(dest); // exclusive: never reuse an existing workspace, even if empty
    execFileSync('tar', ['-xf', '-', '-C', dest], { input: archive, timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (task.seed) {
      const [path, before, after] = task.seed;
      const file = join(dest, path);
      if (!(await lstat(file)).isFile()) throw new Error('seed target must be a regular file');
      await writeFile(file, seedText(await readFile(file, 'utf8'), before, after));
    }
    if (task.archive) await writeFile(join(dest, 'ARCHIVED-NOTE.md'), task.archive, { flag: 'wx' });
    await writeFile(join(dest, 'TASK.md'), `${task.title}\n\n${task.prompt}\n`, { flag: 'wx' });
    git(dest, ['init', '--quiet']);
    const noHooks = join(dest, '.git', 'eval-no-hooks');
    await mkdir(noHooks);
    git(dest, ['config', 'core.autocrlf', 'false']);
    git(dest, ['add', '--all']);
    git(dest, ['-c', 'user.name=AgentRig Eval', '-c', 'user.email=eval@invalid', '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${noHooks}`, 'commit', '--quiet', '-m', `Frozen ${id} input`]);
    const receipt = { version: 1, id, runId: randomUUID(), workspace: await realpath(dest),
      repository: task.repository, revision: task.revision, baseline: git(dest, ['rev-parse', 'HEAD']).trim() };
    await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    return { ...receipt, receiptPath };
  } finally { await receiptHandle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: node eval/workspace.mjs TASK SOURCE NEW_DESTINATION');
    console.log(JSON.stringify(await prepare(...process.argv.slice(2)), null, 2));
  } catch (error) { console.error(`BLOCKED: ${error.message}`); process.exitCode = 2; }
}
