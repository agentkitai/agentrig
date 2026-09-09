// Offline operator publication only. Never call providers or modify original evidence.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { summarize } from '/var/tmp/agentrig-r17f/eval/summarize-live.mjs';
import { summarizeR17f } from '/var/tmp/agentrig-r17f/eval/r17f-summary.mjs';
import { pack } from '/var/tmp/agentrig-r17f/eval/pack-live.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const slot = /^\d{3}-[AX][1-4]-s[01]m[01]-r[1-3]$/;
const range = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);
const same = (a, b, label) => assert.deepEqual(a, b, label);
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export function validateClosure(root, closure) {
  assert(closure && resolve(closure.root) === resolve(root) && closure.joined === true, 'missing joined closure receipt');
  assert(Number.isInteger(closure.handle) && closure.handle > 0 && Number.isInteger(closure.exitCode), 'invalid process closure');
  assert(Number.isFinite(Date.parse(closure.joinedAt)), 'invalid closure time');
  for (const name of ['protocol', 'results', 'calls']) assert(/^[a-f0-9]{64}$/.test(closure.hashes?.[`${name}.json`]), 'missing closure artifact hash');
}
export async function readSegment(root, closure) {
  root = resolve(root);
  validateClosure(root, closure); // operator's joined handle is the closure authority; no PID reuse ambiguity
  const bytes = Object.fromEntries(await Promise.all(['protocol', 'results', 'calls'].map(async name => {
    const path = join(root, `${name}.json`);
    assert((await lstat(path)).isFile(), `not a regular closed artifact: ${name}`);
    return [name, await readFile(path)];
  })));
  for (const [name, value] of Object.entries(bytes)) assert.equal(hash(value), closure.hashes[`${name}.json`], 'closed artifact changed');
  const [protocol, results, calls] = ['protocol', 'results', 'calls'].map(name => JSON.parse(bytes[name]));
  summarize(results);
  assert(Array.isArray(calls), 'calls must be an array');
  assert(calls.every(call => Number.isFinite(call.endedAt) && typeof call.complete === 'boolean'), 'unsettled call record');
  assert.equal(calls.filter(call => !call.complete).length, results.ledger.unknownCalls, 'unknown call accounting differs');
  const keys = results.completed.map(row => row.key);
  const directories = (await readdir(root)).filter(name => slot.test(name)).sort();
  const checks = {};
  for (const key of keys) checks[key] = await json(join(root, key, 'checks.json'));
  return { root, closure, protocol, results, calls, directories, checks,
    hashes: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, hash(value)])) };
}
function normalizedProfile(segment) {
  const profile = structuredClone(segment.protocol.profile);
  // These are only the generated empty config locations, not arbitrary path stripping.
  same(profile.skills, [join(segment.root, 'config-home/.agentrig/skills')], 'unexpected profile skills');
  assert.equal(profile.extensionCwd, join(segment.root, 'config-cwd'), 'unexpected config cwd');
  profile.skills = ['<empty-config-home>/.agentrig/skills']; profile.extensionCwd = '<empty-config-cwd>';
  return profile;
}
export function aggregateSegments(original, continuation, receipt) {
  const a = original, b = continuation;
  assert.equal(receipt.kind, 'explicit-user-authorized-unattempted-slot-continuation');
  assert.equal(resolve(receipt.originalRoot), a.root); assert.equal(resolve(receipt.continuationRoot), b.root);
  assert.notEqual(a.root, b.root);
  same(a.hashes, receipt.originalHashes, 'original evidence changed since authorization');
  assert.equal(a.protocol.revision, receipt.evaluatorRevision);
  for (const key of ['revision', 'model', 'corpus', 'analysis', 'arm', 'armOverrides', 'permissions', 'controls', 'profileSource', 'limitations']) {
    assert(a.protocol[key] !== undefined, `missing protocol identity: ${key}`);
    same(a.protocol[key], b.protocol[key], `changed protocol ${key}`);
  }
  for (const key of ['worker', 'checker', 'source', 'memoryCorpus', 'arm', 'dependencies', 'rounds'])
    same(a.protocol.settings[key], b.protocol.settings[key], `changed setting ${key}`);
  for (const key of ['perAttempt', 'hangGuardMs', 'requestTimeoutMs'])
    same(a.protocol.budget[key], b.protocol.budget[key], `changed per-attempt limit ${key}`);
  same(normalizedProfile(a), normalizedProfile(b), 'changed resolved profile');
  same(b.protocol.settings, receipt.settings, 'continuation settings differ from receipt');
  assert.equal(a.protocol.settings.output, a.root); assert.equal(b.protocol.settings.output, b.root);
  const n = a.results.completed.length;
  same(a.protocol.schedule.slots, range(0, 96), 'original schedule is not full');
  same(receipt.slots, range(n, 96), 'authorization is not unattempted suffix');
  same(b.protocol.schedule.slots, receipt.slots, 'continuation schedule changed');
  same(a.results.completed.map(row => Number(row.key.slice(0, 3)) - 1), range(0, n), 'original schedule has gaps');
  same(b.results.completed.map(row => Number(row.key.slice(0, 3)) - 1), range(n, n + b.results.completed.length), 'continuation has overlap or gaps');
  // First run must not have an unreported started slot that continuation would repeat.
  same(a.directories, a.results.completed.map(row => row.key).sort(), 'original has unaccounted attempted slot');
  const bKeys = b.results.completed.map(row => row.key).sort();
  assert(bKeys.every(key => b.directories.includes(key)), 'completed evidence directory missing');
  const extras = b.directories.filter(key => !bKeys.includes(key));
  assert(extras.length <= 1 && extras.every(key => Number(key.slice(0, 3)) === n + bKeys.length + 1 && Number(key.slice(0, 3)) <= 96), 'unexpected partial continuation slot');
  assert.equal(a.results.ledger.tokens, receipt.previousReportedTokens);
  assert.equal(a.results.ledger.unknownCalls, receipt.previousUnknownCalls);
  assert.equal(b.protocol.budget.totalTokens, receipt.segmentCap);
  assert(receipt.previousReportedTokens + receipt.unknownReserve + receipt.segmentCap <= receipt.authorizedTotal, 'authorization exceeded at scheduling');
  const stops = [a, b].map((segment, index) => ({ segment: index + 1, blocked: segment.results.ledger.blocked }));
  const derived = { planned: 96, completed: [...a.results.completed, ...b.results.completed], ledger: {
    startedAt: a.results.ledger.startedAt,
    tokens: a.results.ledger.tokens + b.results.ledger.tokens,
    unknownCalls: a.results.ledger.unknownCalls + b.results.ledger.unknownCalls,
    blocked: stops.filter(stop => stop.blocked !== null).map(stop => `segment ${stop.segment}: ${stop.blocked}`).join('; ') || null,
  } };
  summarize(derived); // catches duplicate/mismatched fixed task identities too
  return { format: 'agentrig-r17f-derived-continuation-summary-v1',
    authority: 'Derived analysis of separately preserved raw segments; not a canonical runner results.json. Interrupted chronology and unknown usage are retained.',
    continuation: receipt, segments: [a, b].map((segment, i) => ({ segment: i + 1, root: segment.root,
      closure: segment.closure, hashes: segment.hashes, ledger: segment.results.ledger,
      completed: segment.results.completed.length, createdSlots: segment.directories })),
    summary: summarizeR17f(derived, { ...a.checks, ...b.checks }) };
}
export async function verifyArchive(root, publication) {
  const index = await json(join(publication, 'index.json'));
  const compressed = await readFile(join(publication, 'evidence.json.gz'));
  assert.equal(hash(compressed), index.archiveSha256); assert.equal(compressed.length, index.archiveBytes);
  const bundle = JSON.parse(gunzipSync(compressed));
  assert.equal(bundle.format, index.format); assert.equal(bundle.evaluatorRevision, index.evaluatorRevision);
  same(Object.keys(bundle.files).sort(), Object.keys(index.files).sort());
  for (const [path, entry] of Object.entries(bundle.files)) {
    assert(!path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'), 'unsafe archive path');
    const bytes = Buffer.from(entry.base64, 'base64');
    same({ bytes: bytes.length, sha256: hash(bytes) }, index.files[path]);
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    assert(bytes.equals(await readFile(join(root, path))), `archive differs: ${path}`);
  }
  return { files: Object.keys(bundle.files).length, archiveBytes: compressed.length, archiveSha256: hash(compressed) };
}
export async function publish(config) {
  const receipt = await json(config.continuationReceipt);
  const a = await readSegment(receipt.originalRoot, config.closures[0]);
  const b = await readSegment(receipt.continuationRoot, config.closures[1]);
  const aggregate = aggregateSegments(a, b, receipt);
  // Verify the old invalid archive too, but never merge its results or usage into corrected analysis.
  const invalid = await verifyArchive(config.invalidRoot, config.invalidPublication);
  assert.equal(invalid.archiveSha256, 'a3d2bbaea15a491bbad639b409569d00d676d489ef438482237a4011b3915ce8');
  const destination = resolve(config.destination);
  await mkdir(destination); // exclusive new publication only
  const published = [];
  for (const [i, segment] of [a, b].entries()) {
    validateClosure(segment.root, segment.closure);
    const target = join(destination, `segment-${i + 1}`);
    await pack(segment.root, target);
    published.push(await verifyArchive(segment.root, target));
    const after = await readSegment(segment.root, segment.closure);
    same(after.hashes, segment.hashes, 'closed segment changed during publication');
  }
  const invalidTarget = join(destination, 'invalid-pilot');
  await mkdir(invalidTarget);
  for (const file of ['evidence.json.gz', 'index.json']) await copyFile(join(config.invalidPublication, file), join(invalidTarget, file), 1);
  await verifyArchive(config.invalidRoot, invalidTarget);
  await save(join(destination, 'aggregate-summary.json'), aggregate);
  await save(join(destination, 'publication.json'), { format: 'agentrig-r17f-segmented-publication-v1', published,
    invalidPilot: { ...invalid, reportedTokens: 306143, unknownCalls: 1, includedInCorrectedAnalysis: false },
    note: 'Segment raw artifacts are authoritative. Aggregate summary is derived; original unknown call and stop reason remain. No new human judgments.' });
  return { destination, completed: aggregate.summary.all.completed, balancedCount: aggregate.summary.balancedCount,
    reportedTokens: aggregate.summary.all.ledger.tokens, unknownCalls: aggregate.summary.all.ledger.unknownCalls };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { assert.equal(process.argv.length, 3, 'usage: node publish-segments.mjs CONFIG.json'); console.log(JSON.stringify(await publish(await json(process.argv[2])))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
