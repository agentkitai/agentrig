// Compile and execute, rather than testing the source alias that hid the ESM regression.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { cliBundleOptions } from './bundle.mjs';
const cli = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'));
assert.ok(manifest.dependencies.typescript, 'external lazy parser must be a direct CLI runtime dependency, not accidentally resolved from root devDependencies');
// Under the package so external dependencies resolve exactly as in dist/.
const root = await mkdtemp(join(cli, '.feel-bundle-'));
try {
  const entry = join(root, 'entry.ts');
  await writeFile(entry, `export { generateRepoMap, exportedSignatures } from ${JSON.stringify(fileURLToPath(new URL('../../core/src/repo-map.ts', import.meta.url)))};\n`);
  const fixture = join(root, 'fixture');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(fixture);
  await writeFile(join(fixture, 'api.ts'), 'export function visibleSignature(name: string): number { return name.length; }\n');
  await build({ ...cliBundleOptions, absWorkingDir: cli, entryPoints: [entry], outdir: join(root, 'dist') });
  const { generateRepoMap, exportedSignatures } = await import(pathToFileURL(join(root, 'dist/entry.js')).href);
  assert.match((await exportedSignatures("api.ts", "export function visibleSignature(name: string): number { return name.length; }")).join("\n"), /visibleSignature\(name: string\): number/);
  const map = await generateRepoMap(fixture);
  assert.match(map.content, /visibleSignature\(name: string\): number/);
  console.log('PASS: compiled ESM TypeScript repository-map signatures');
} finally { await rm(root, { recursive: true, force: true }); }
