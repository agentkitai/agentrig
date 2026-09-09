import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { continuationPlan } from './resume-remaining.mjs';
const root = '/var/tmp/agentrig-r17f-work.ZhA9M7/live-r17f-corrected-20260909';
const results = JSON.parse(await readFile(`${root}/results.json`));
const calls = JSON.parse(await readFile(`${root}/calls.json`));
const protocol = JSON.parse(await readFile(`${root}/protocol.json`));
const directories = await readdir(root);
test('resumes exactly unattempted slots and includes prior usage and unknown reserve', () => {
  const plan = continuationPlan(results, calls, directories, protocol);
  assert.deepEqual(plan.slots, Array.from({ length: 45 }, (_, i) => i + 51));
  assert.equal(plan.previousReportedTokens + plan.unknownReserve + plan.segmentCap, 19490295);
  assert.equal(plan.previousUnknownCalls, 1);
});
test('refuses missing, reordered, or duplicated completed outcomes', () => {
  for (const mutate of [r => r.completed.pop(), r => r.completed.reverse(), r => { r.completed[1] = r.completed[0]; }]) {
    const r = structuredClone(results); mutate(r);
    assert.throws(() => continuationPlan(r, calls, directories, protocol));
  }
});
test('refuses an already-started next slot or unaccounted usage', () => {
  assert.throws(() => continuationPlan(results, calls, [...directories, '052-X1-s0m0-r2'], protocol));
  assert.throws(() => continuationPlan({ ...results, ledger: { ...results.ledger, tokens: 6312296 } }, calls, directories, protocol));
  assert.throws(() => continuationPlan(results, calls.filter(c => c.complete), directories, protocol));
});
test('refuses changed frozen evaluator', () => {
  assert.throws(() => continuationPlan(results, calls, directories, { ...protocol, revision: '0'.repeat(40) }));
});
