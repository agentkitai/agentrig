import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { taskFor, allowedPath } from './tasks.mjs';

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { z } = require('zod');
const Receipt = z.object({ version: z.literal(1), id: z.string(), runId: z.string().uuid(), workspace: z.string(),
  repository: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/), baseline: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const Evidence = z.array(z.object({ path: z.string(), quote: z.string().min(12).max(1000) }).strict()).min(1).max(8);
const AccountingAnswer = z.object({ eventType: z.literal('auxiliary.usage'), snapshots: z.literal('replace-by-id'),
  finalEvent: z.literal('session.end'), missingUsage: z.literal('unknown'), mainIncludesAuxiliary: z.literal(false), evidence: Evidence.min(2) }).strict();
const CoercionAnswer = z.object({ whitespace: z.literal(false), trueValue: z.literal(false), nullValue: z.literal(false),
  hexString: z.literal(true), boxedNumber: z.literal(false), evidence: Evidence }).strict();

const command = (cwd, program, args, options = {}) => execFileSync(program, args, {
  cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options,
});
const git = (cwd, args) => command(cwd, 'git', args);
const leafImport = (root, path) => import(pathToFileURL(join(root, path)).href);
const fm = { type: 'entity', slug: 'fixture', aliases: [], sources: ['doc:fixture'], updated: '2026-09-05', confidence: 'high' };
const page = (slug, body) => ({ path: `entities/${slug}.md`, frontmatter: { ...fm, slug }, body, updatedAt: 0 });

export async function behavior(id, root) {
  if (id === 'A1') {
    const { serializePage, parsePage } = await leafImport(root, 'packages/memory/dist/page.js');
    for (const alias of ['plain', 'last, first', ' leading ', 'say "hello"', "single'quote", 'a\\b', 'line\nbreak']) {
      const input = { ...fm, aliases: [alias, 'stable'] };
      const actual = parsePage(serializePage(input, '- [stated] Kept (doc:fixture)', {}, 'owner:\n  name: Ada'));
      assert.deepEqual(actual.frontmatter, input);
      assert.equal(actual.extraFrontmatter, 'owner:\n  name: Ada');
      assert.match(actual.body, /Kept \(doc:fixture\)/);
    }
  } else if (id === 'A2') {
    const { unionRetrieve } = await leafImport(root, 'packages/memory/dist/search.js');
    const pages = [page('catalog', 'unrelated content'), page('body', 'nebula appears here')];
    const entries = [{ slug: 'catalog', path: pages[0].path, type: 'entity', status: 'active', summary: 'nebula' }];
    const hits = unionRetrieve(entries, pages, 'nebula', 1);
    assert.deepEqual(hits.map((h) => [h.page.path, h.via]), [['entities/catalog.md', 'index'], ['entities/body.md', 'bm25']]);
    const both = unionRetrieve([{ ...entries[0], path: pages[1].path }], pages, 'nebula', 1);
    assert.deepEqual(both.map((h) => h.via), ['both']);
    assert.deepEqual(unionRetrieve(entries, pages, 'the and', 1), []);
  } else if (id === 'A3') {
    const extracted = await leafImport(root, 'packages/memory/dist/wikilinks.js');
    const original = await leafImport(root, 'packages/memory/dist/page.js');
    const publicApi = await leafImport(root, 'packages/memory/dist/index.js');
    assert.equal(extracted.wikilinks, original.wikilinks);
    assert.equal(extracted.wikilinks, publicApi.wikilinks);
    assert.deepEqual(extracted.wikilinks('[[beta]] [[ alpha ]] [[beta]] [[ ]] ordinary [[gamma]]'), ['beta', 'alpha', 'gamma']);
    assert.deepEqual(extracted.wikilinks('no links here'), []);
    // The requested extraction must be real, not a second wrapper around the old implementation.
    const old = await readFile(join(root, 'packages/memory/src/page.ts'), 'utf8');
    assert.doesNotMatch(old, /(?:function|const|let)\s+wikilinks\b/);
  } else if (id === 'A4' || id === 'X4') {
    const bytes = await readFile(join(root, 'answer.json'), 'utf8');
    assert.ok(bytes.length <= 16_384, 'answer is too large');
    const answer = (id === 'A4' ? AccountingAnswer : CoercionAnswer).parse(JSON.parse(bytes));
    const allowedEvidence = id === 'A4'
      ? ['packages/core/src/events.ts', 'packages/core/src/agent.ts', 'packages/cli/src/render.ts', 'packages/memory/src/maintenance.ts']
      : ['index.js'];
    for (const item of answer.evidence) {
      assert.ok(allowedEvidence.includes(item.path), 'evidence must cite current implementation');
      assert.ok((await readFile(join(root, item.path), 'utf8')).includes(item.quote), 'quote must occur in source');
    }
    if (id === 'A4') assert.ok(new Set(answer.evidence.map((e) => e.path)).size >= 2, 'cite two implementation files');
    const explanation = await readFile(join(root, 'answer.md'), 'utf8');
    assert.ok(explanation.trim().length >= 80 && explanation.length <= 8192, 'include a concise explanation');
    // Semantics of prose remain a declared human check, not a string/LLM-grader claim.
  } else {
    const localRequire = createRequire(join(root, 'package.json'));
    const number = localRequire('./index.js');
    const inputs = [0, -1.25, Number.MAX_VALUE, NaN, Infinity, -Infinity, '0', '0xff', '1e3', ' 2 ', '', ' \r\n\t',
      true, false, null, undefined, [], [1], {}, new Number(2), 2n, Symbol('x')];
    if (id === 'X1') {
      for (const input of inputs) assert.equal(number(input), typeof input === 'number' ? Number.isFinite(input)
        : typeof input === 'string' && input.trim() !== '' && Number.isFinite(Number(input)), String(input));
    } else if (id === 'X2') {
      const strict = localRequire('./strict.js');
      for (const input of inputs) assert.equal(strict(input), typeof input === 'number' && Number.isFinite(input), String(input));
    } else if (id === 'X3') {
      const classify = localRequire('./classify.js');
      for (const input of inputs) assert.equal(classify(input), typeof input === 'number' && Number.isFinite(input) ? 'number'
        : typeof input === 'string' && input.trim() !== '' && Number.isFinite(Number(input)) ? 'numeric-string' : 'other', String(input));
    } else throw new Error(`unknown behavior: ${id}`);
  }
}

export async function regression(id, root) {
  if (id.startsWith('A')) {
    // Launch the pinned project's test runner without a shell (portable on Windows).
    return command(root, process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'packages/memory/test/page.test.ts', 'packages/memory/test/search.test.ts']);
  }
  // The pinned upstream suite is synchronous and needs only describe/it, assert and the predicate.
  // Adapt those two Mocha primitives, without resolving unpinned legacy dev dependencies.
  let count = 0;
  const localRequire = createRequire(join(root, 'package.json'));
  const upstream = await readFile(join(root, 'test.js'), 'utf8');
  vm.runInNewContext(upstream, {
    require(name) {
      if (name === 'mocha') return {};
      if (name === 'assert') return require('node:assert');
      if (name === './') return localRequire('./index.js');
      throw new Error(`unexpected upstream dependency: ${name}`);
    },
    describe(_name, fn) { fn(); }, it(_name, fn) { fn(); count++; },
  }, { timeout: 2000, filename: 'upstream-test.js' });
  assert.ok(count > 100, 'upstream suite must execute, not silently skip');
  return `${count} pinned upstream synchronous cases passed (adapted runner, not Mocha)`;
}

export async function check(receiptPath) {
  const raw = await readFile(receiptPath, 'utf8');
  if (raw.length > 16_384) throw new Error('receipt too large');
  const receipt = Receipt.parse(JSON.parse(raw));
  const task = taskFor(receipt.id);
  assert.equal(receipt.revision, task.revision);
  assert.equal(receipt.repository, task.repository);
  const root = await realpath(receipt.workspace);
  assert.equal(root, receipt.workspace);
  assert.equal(git(root, ['rev-parse', `${receipt.baseline}^{commit}`]).trim(), receipt.baseline);
  const result = { task: receipt.id, runId: receipt.runId, outcome: 'FAIL', behavior: 'BLOCKED', regression: 'BLOCKED', submittedTests: 'BLOCKED',
    scope: 'PASS', manual: receipt.id === 'A4' || receipt.id === 'X4' ? 'PENDING' : 'NOT_REQUIRED', evidence: [] };
  // Compare against the external baseline receipt, not HEAD (an agent may commit its work).
  const changed = git(root, ['diff', '--name-only', '-z', receipt.baseline, '--']).split('\0').filter(Boolean);
  const added = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const forbidden = [...new Set([...changed, ...added])].filter((path) => !allowedPath(receipt.id, path));
  if (forbidden.length) { result.scope = 'FAIL'; result.evidence.push(`out-of-scope changes: ${forbidden.join(', ')}`); }
  for (const path of new Set([...changed, ...added])) {
    try { assert.ok((await lstat(join(root, path))).isFile(), `changed path must be a regular file: ${path}`); }
    catch (error) { result.scope = 'FAIL'; result.evidence.push(error.message); }
  }
  if (result.scope === 'FAIL') return result;
  if (receipt.id.startsWith('A')) {
    // Missing prerequisites are BLOCKED; compilation failures in a prepared run are FAIL.
    await lstat(join(root, 'node_modules/typescript/bin/tsc'));
    await lstat(join(root, 'node_modules/vitest/vitest.mjs'));
    try {
      const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      // pnpm.cmd requires a shell on Windows; no user-controlled argument is interpolated.
      result.evidence.push(command(root, pnpm, ['build'], { shell: process.platform === 'win32' }));
    } catch (error) { result.behavior = 'FAIL'; result.evidence.push(`build failed: ${error.message}`); return result; }
  }
  for (const kind of ['behavior', 'regression']) {
    try {
      const output = command(root, process.execPath, [fileURLToPath(import.meta.url), '--worker', kind, receipt.id, root]);
      result[kind] = 'PASS'; result.evidence.push(`${kind}: ${output.trim()}`);
    } catch (error) { result[kind] = 'FAIL'; result.evidence.push(`${kind}: ${error.stderr || error.message}`); }
  }
  if (receipt.id === 'A4' || receipt.id === 'X4') result.submittedTests = 'NOT_REQUIRED';
  else {
    const testFiles = [...new Set([...changed, ...added])].filter((p) => !task.allowed.includes(p));
    try {
      assert.ok(testFiles.length > 0, 'task requires at least one new eval-* regression test');
      if (receipt.id.startsWith('A')) result.evidence.push(command(root, process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', ...testFiles]));
      else for (const file of testFiles) result.evidence.push(command(root, process.execPath, [file]));
      result.submittedTests = 'PASS';
    } catch (error) { result.submittedTests = 'FAIL'; result.evidence.push(`submitted tests: ${error.stderr || error.message}`); }
  }
  result.outcome = result.behavior === 'PASS' && result.regression === 'PASS' && result.submittedTests !== 'FAIL'
    ? result.manual === 'PENDING' ? 'BLOCKED' : 'PASS' : 'FAIL';
  if (result.manual === 'PENDING') result.evidence.push('Independent human must assess answer.md against EVALSET rubric; record signed verdict separately.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--worker') {
      const [, , , kind, id, root] = process.argv;
      taskFor(id);
      if (!['behavior', 'regression'].includes(kind)) throw new Error('unknown worker');
      console.log(await (kind === 'behavior' ? behavior : regression)(id, root) ?? 'independent assertions passed');
    } else {
      if (process.argv.length !== 3) throw new Error('usage: node eval/check.mjs EXTERNAL_RECEIPT');
      const result = await check(process.argv[2]);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.outcome === 'PASS' ? 0 : result.outcome === 'FAIL' ? 1 : 2;
    }
  } catch (error) {
    if (process.argv[2] === '--worker') { console.error(error); process.exitCode = 1; }
    else { console.log(JSON.stringify({ outcome: 'BLOCKED', reason: error.message })); process.exitCode = 2; }
  }
}
