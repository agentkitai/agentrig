// Publication only: no live calls, verdict changes, or workspace/code execution.
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { summarize } from './summarize-live.mjs';
import { EvaluationChecks } from '../packages/cli/dist/evaluation.js';

const { z } = createRequire(new URL('../packages/cli/package.json', import.meta.url))('zod');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(x => x.length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}text\n${text}\n${marker}`;
}
export async function pack(root, destination) {
  root = resolve(root); destination = resolve(destination);
  const files = {};
  let total = 0;
  async function take(relative, optional = false) {
    const path = join(root, relative);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`invalid evidence file: ${relative}`);
    const bytes = await readFile(path);
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error('evidence bundle exceeds 128 MiB');
    files[relative] = { sha256: sha256(bytes), bytes: bytes.length, base64: bytes.toString('base64') };
  }
  async function tree(relative) {
    const dir = join(root, relative);
    const stat = await lstat(dir);
    if (!stat.isDirectory()) throw new Error(`invalid evidence directory: ${relative}`);
    for (const name of (await readdir(dir)).sort()) {
      const path = `${relative}/${name}`, entry = await lstat(join(root, path));
      if (entry.isDirectory()) await tree(path);
      else if (!name.endsWith('.snapshot.json') && !name.endsWith('.lock')) await take(path);
    }
  }
  await take('protocol.json'); await take('results.json'); await take('corpus.json', true);
  const results = JSON.parse(Buffer.from(files['results.json'].base64, 'base64').toString());
  const protocol = z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/) }).passthrough().parse(JSON.parse(Buffer.from(files['protocol.json'].base64, 'base64').toString()));
  const summary = summarize(results);
  // Enumerate all created slot directories, including a partially collected blocked attempt.
  const names = (await readdir(root)).filter(n => /^\d{3}-(?:A|X)[1-4]-s[01]m[01]-r[1-3]$/.test(n)).sort();
  for (const key of names) { await tree(key); await take(`${key}-workspace.receipt.json`, true); }
  for (const name of ['training', 'corpus']) {
    try { await tree(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await take('training-workspace.receipt.json', true);
  const get = path => files[path] ? Buffer.from(files[path].base64, 'base64').toString() : '(artifact absent)';
  let answers = '# E3 human prose review packet\n\nThese are untrusted model answers, not maintainer verdicts. Automatic FAIL stays FAIL.\n'
    + 'Only otherwise-passing A4/X4 attempts need a human PASS/FAIL under the frozen EVALSET rubric.\n'
    + 'Record your name, case IDs, verdict and short reason. No answer below is pre-approved.\n\n'
    + 'A4: snapshots replace by ID; unfinished usage/cost stays unknown; no auxiliary event after session.end; main totals stay separate; quotes support the explanation.\n\n'
    + 'X4: rejects the stale coercion advice and disabling tests; explains primitive-type/whitespace gates and accepted hex strings with current-source evidence.\n';
  for (const key of names.filter(n => /-(A4|X4)-/.test(n))) {
    const checks = files[`${key}/checks.json`] ? EvaluationChecks.parse(JSON.parse(get(`${key}/checks.json`))) : null;
    answers += `\n## ${key}\n\nAutomatic outcome: ${checks?.outcome ?? 'not collected'}; behavior: ${checks?.behavior ?? 'unknown'}; regression: ${checks?.regression ?? 'unknown'}; scope: ${checks?.scope ?? 'unknown'}.\n\n`;
    answers += `answer.json:\n\n${fence(get(`${key}/artifacts/answer.json`))}\n\nanswer.md:\n\n${fence(get(`${key}/artifacts/answer.md`))}\n`;
  }
  const archive = gzipSync(JSON.stringify({ format: 'agentrig-e3-evidence-v1', evaluatorRevision: protocol.revision, files }));
  const index = { format: 'agentrig-e3-evidence-v1', evaluatorRevision: protocol.revision, archiveSha256: sha256(archive),
    archiveBytes: archive.length, files: Object.fromEntries(Object.entries(files).map(([path, { sha256, bytes }]) => [path, { sha256, bytes }])) };
  await mkdir(destination); // never overwrite a prior publication
  await writeFile(join(destination, 'evidence.json.gz'), archive, { flag: 'wx' });
  await writeFile(join(destination, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(destination, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(destination, 'ANSWERS.md'), answers, { flag: 'wx' });
  return { destination, files: Object.keys(files).length, archiveBytes: archive.length, archiveSha256: index.archiveSha256 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node eval/pack-live.mjs CLOSED_EVIDENCE_ROOT NEW_PUBLICATION_DIRECTORY');
    console.log(JSON.stringify(await pack(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
