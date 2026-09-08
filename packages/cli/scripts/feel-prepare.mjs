// Explicit dependency preparation, NOT part of the offline measurement. Like the
// root frozen install, this may contact the registry; package scripts never run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../../eval/workspace.mjs';
import { tasks } from '../../../eval/tasks.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.equal(new Set(Object.entries(tasks).filter(([id]) => id.startsWith('A')).map(([, task]) => task.revision)).size, 1, 'prepare each distinct A-task pin if the E1 revisions diverge');
const temp = await realpath(await mkdtemp(join(tmpdir(), 'r17c-dependencies-')));
try {
  const fixture = await prepare('A1', root, join(temp, 'fixture'));
  // A content-store hit is insufficient: pnpm also needs metadata to enforce the
  // pinned lockfile's supply-chain policy offline. Never disable that policy.
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: fixture.workspace, stdio: 'inherit', timeout: 120000 });
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: fixture.workspace, stdio: 'inherit', timeout: 120000 });
  console.log('Prepared pinned E1 dependency content and policy metadata; offline control passed.');
} finally { await rm(temp, { recursive: true, force: true }); }
