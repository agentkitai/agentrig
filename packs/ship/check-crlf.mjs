#!/usr/bin/env node
// Run the complete instruction/script lane against actual CRLF compatibility copies.
import { mkdtemp, readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'ship-crlf-'));
try {
  await cp(join(root, '.agentrig/skills'), fixture, { recursive: true });
  for (const entry of await readdir(fixture, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packs/ship/vitest.config.ts', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, AGENTRIG_TEST_SKILLS_ROOT: fixture },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
