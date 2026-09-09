import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { aggregateSegments, readSegment, validateClosure, verifyArchive } from './publish-segments.mjs';
import { schedule } from '/var/tmp/agentrig-r17f/eval/live-support.mjs';
import { pack } from '/var/tmp/agentrig-r17f/eval/pack-live.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const rows = schedule().map((row, index) => ({ ...row,
  key: `${String(index + 1).padStart(3, '0')}-${row.task}-s${+row.supervisor}m${+row.memory}-r${row.repeat}`,
  outcome: row.memory ? 'PASS' : 'FAIL', reportedTokens: 10, wallMs: 100 }));
function fixture(end = 96) {
  const make = (root, start, stop, unknown) => {
    const settings = { output: root, worker: 'worker', checker: 'checker', source: 'source', memoryCorpus: 'corpus', arm: 'heuristics+llm', dependencies: 'offline-image', rounds: 3, totalTokens: 12000000 };
    const protocol = { revision: '4'.repeat(40), settings, model: { model: 'luna' }, corpus: { sha256: 'x' }, analysis: { primary: 6 },
      arm: 'heuristics+llm', armOverrides: { supervisorReview: true }, permissions: 'ask', controls: ['fixed'], profileSource: 'empty', limitations: ['frozen'],
      profile: { skills: [join(root, 'config-home/.agentrig/skills')], extensionCwd: join(root, 'config-cwd'), ingestOnEnd: true },
      budget: { totalTokens: 12000000, perAttempt: { turns: 24 }, hangGuardMs: 390000, requestTimeoutMs: 60000 }, schedule: { slots: range(start, 96) } };
    const completed = rows.slice(start, stop);
    return { root, protocol, results: { planned: 96, completed, ledger: { tokens: completed.length * 10, startedAt: 1 + start, unknownCalls: unknown, blocked: unknown ? 'provider usage incomplete' : null } },
      calls: [], hashes: { protocol: 'a', results: 'b', calls: 'c' }, closure: {}, directories: completed.map(row => row.key).sort(),
      checks: Object.fromEntries(completed.map(row => [row.key, { regression: 'PASS', scope: 'PASS' }])) };
  };
  const a = make('/fixture/one', 0, 51, 1), b = make('/fixture/two', 51, end, 0);
  const receipt = { kind: 'explicit-user-authorized-unattempted-slot-continuation', originalRoot: a.root, continuationRoot: b.root,
    originalHashes: a.hashes, evaluatorRevision: a.protocol.revision, slots: range(51, 96), settings: b.protocol.settings,
    previousReportedTokens: 510, previousUnknownCalls: 1, unknownReserve: 1178000, segmentCap: 12000000, authorizedTotal: 20000000 };
  return { a, b, receipt };
}
test('96 disjoint outcomes aggregate but old unknown and stop reason prevent a numerical win', () => {
  const { a, b, receipt } = fixture(); const before = JSON.stringify([a, b, receipt]);
  const out = aggregateSegments(a, b, receipt);
  assert.equal(out.summary.balancedCount, 96); assert.equal(out.summary.all.ledger.tokens, 960);
  assert.equal(out.summary.all.ledger.unknownCalls, 1);
  assert.match(out.summary.all.ledger.blocked, /segment 1: provider usage incomplete/);
  assert(out.summary.comparisons.some(row => row.additionalPasses >= 2));
  assert(out.summary.comparisons.every(row => !row.numericalThresholdMet));
  assert.equal(JSON.stringify([a, b, receipt]), before);
  assert(!('results' in out));
});
test('partial continuation uses largest complete prefix and preserves tail observations', () => {
  const { a, b, receipt } = fixture(70); const out = aggregateSegments(a, b, receipt);
  assert.equal(out.summary.balancedCount, 64); assert.equal(out.summary.partialObservations.length, 6);
  assert.equal(out.summary.partialRerun, true);
});
test('refuses changed model/images/corpus/analysis and changed resolved defaults', () => {
  for (const edit of [b => b.protocol.model.model = 'other', b => b.protocol.settings.checker = 'other',
    b => b.protocol.corpus.sha256 = 'other', b => b.protocol.analysis.primary = 8,
    b => b.protocol.profile.ingestOnEnd = false]) {
    const { a, b, receipt } = fixture(); edit(b); assert.throws(() => aggregateSegments(a, b, receipt));
  }
});
test('refuses overlapping/gapped outcomes, repeated attempted slot and drifted authorization', () => {
  for (const edit of [({ b }) => b.results.completed[0] = rows[50], ({ b }) => b.results.completed.splice(0, 1),
    ({ a }) => a.directories.push(rows[51].key), ({ receipt }) => receipt.authorizedTotal = 100,
    ({ receipt }) => receipt.originalHashes = { ...receipt.originalHashes, calls: 'changed' }]) {
    const x = fixture(); edit(x); assert.throws(() => aggregateSegments(x.a, x.b, x.receipt));
  }
});
test('refuses unclosed/active receipt before trying nonexistent evidence root', async () => {
  assert.throws(() => validateClosure('/not-created', { root: '/not-created', joined: false }), /joined/);
  await assert.rejects(readSegment('/not-created', null), /joined/);
});
test('closed files are hash-bound and unsettled calls refused', async () => {
  const root = await mkdtemp('/var/tmp/agentrig-r17f-publication-test-');
  try {
    const values = { protocol: { revision: 'a'.repeat(40) }, results: { planned: 96, completed: [], ledger: { startedAt: 1, tokens: 0, unknownCalls: 0, blocked: null } }, calls: [] };
    const closure = { root, joined: true, handle: 123, exitCode: 0, joinedAt: new Date().toISOString(), hashes: {} };
    async function save(name) { const bytes = JSON.stringify(values[name]); await writeFile(join(root, `${name}.json`), bytes); closure.hashes[`${name}.json`] = hash(bytes); }
    for (const name of Object.keys(values)) await save(name);
    assert.equal((await readSegment(root, closure)).results.completed.length, 0);
    await writeFile(join(root, 'calls.json'), '[{}]');
    await assert.rejects(readSegment(root, closure), /closed artifact changed/);
    values.calls = [{ complete: true }]; await save('calls');
    await assert.rejects(readSegment(root, closure), /unsettled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('existing pack plus verifier preserves bytes and detects archive/index drift', async () => {
  const root = await mkdtemp('/var/tmp/agentrig-r17f-publication-test-');
  try {
    const evidence = join(root, 'evidence'), publication = join(root, 'published'); await mkdir(evidence);
    await writeFile(join(evidence, 'protocol.json'), JSON.stringify({ revision: 'a'.repeat(40) }));
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ planned: 96, completed: [], ledger: { startedAt: 1, tokens: 0, unknownCalls: 0, blocked: null } }));
    await pack(evidence, publication); assert.equal((await verifyArchive(evidence, publication)).files, 2);
    const indexPath = join(publication, 'index.json'); const index = JSON.parse(await readFile(indexPath));
    index.archiveSha256 = '0'.repeat(64); await writeFile(indexPath, JSON.stringify(index));
    await assert.rejects(verifyArchive(evidence, publication));
  } finally { await rm(root, { recursive: true, force: true }); }
});
