// R17f: recover E3's frozen memory corpus from the committed evidence archive.
// Read-only, network-free, no model call. Reusing the original corpus keeps R17f comparable
// with E3 and spends no training tokens; retraining would produce a different corpus.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestTree } from './live-support.mjs';

/** Recorded in docs/E3-RESULTS.md; both are checked, never inferred from the file on disk. */
export const E3_ARCHIVE_SHA256 = 'e0089e84abb625e048cd220c98beaa8eb37a9ad96e478faddb21dc32c6cf2bd5';
export const E3_CORPUS_SHA256 = 'cd10a022f0114f75726f7d6024324ad92d4646a94d608af0fd2f9113e256b2a1';
export const E3_ARCHIVE = fileURLToPath(new URL('../docs/e3-evidence/evidence.json.gz', import.meta.url));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MEMORY_ON = /^(\d{3}-(?:A|X)[1-4]-s[01]m1-r[1-3])\/wiki\/(.+)$/;

/** Every memory-on attempt received a copy of the same frozen corpus. Agreement across all of
 * them is checked from the archive's own hashes, so one copy cannot silently stand in. */
export function frozenCorpusCopies(bundle) {
  const copies = new Map();
  for (const [path, entry] of Object.entries(bundle.files)) {
    const matched = MEMORY_ON.exec(path);
    if (matched === null) continue;
    const [, attempt, relative] = matched;
    if (relative.split('/').includes('..') || relative.startsWith('/')) throw new Error('unsafe archived corpus path');
    if (!copies.has(attempt)) copies.set(attempt, new Map());
    copies.get(attempt).set(relative, entry);
  }
  if (copies.size === 0) throw new Error('archive contains no memory-on corpus copy');
  const attempts = [...copies.keys()].sort();
  const canonical = copies.get(attempts[0]);
  const fingerprint = files => [...files.entries()].map(([p, e]) => `${p}:${e.sha256}`).sort().join('\n');
  const expected = fingerprint(canonical);
  for (const attempt of attempts)
    if (fingerprint(copies.get(attempt)) !== expected) throw new Error(`archived corpus copies disagree: ${attempt}`);
  return { attempt: attempts[0], attempts: attempts.length, files: canonical };
}

/** Writes the corpus into a directory that must not already exist. Never overwrites or resumes. */
export async function extractFrozenCorpus(destination, archive = E3_ARCHIVE) {
  const bytes = await readFile(archive);
  if (sha256(bytes) !== E3_ARCHIVE_SHA256) throw new Error('evidence archive does not match its published SHA-256');
  const bundle = JSON.parse(gunzipSync(bytes));
  const { attempt, attempts, files } = frozenCorpusCopies(bundle);
  const root = resolve(destination);
  await mkdir(root); // exclusive; an existing directory is an operator error, not a merge
  for (const [relative, entry] of [...files.entries()].sort()) {
    const content = Buffer.from(entry.base64, 'base64');
    if (sha256(content) !== entry.sha256) throw new Error(`archived corpus file does not match its index hash: ${relative}`);
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
  }
  const digest = await digestTree(root);
  if (digest !== E3_CORPUS_SHA256) throw new Error('recovered corpus does not match the frozen E3 corpus digest');
  return { path: root, sha256: digest, files: files.size, source: { archive, attempt, attempts } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await extractFrozenCorpus(process.argv[2]), null, 2)); }
  catch (error) { console.error(`BLOCKED: ${error.message}`); process.exitCode = 2; }
}
