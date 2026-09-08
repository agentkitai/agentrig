// Read-only R17f analysis: fixed balanced prefix, all partial observations retained.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize, spread } from './summarize-live.mjs';

export function summarizeR17f(results, checks = {}) {
  const all = summarize(results); // validates identities, duplicate slots and numeric bounds
  const byOrdinal = new Map(results.completed.map(row => [Number(row.key.slice(0, 3)), row]));
  let prefix = 0;
  while (byOrdinal.has(prefix + 1)) prefix++;
  const balancedCount = Math.floor(prefix / 32) * 32;
  const balanced = results.completed.filter(row => Number(row.key.slice(0, 3)) <= balancedCount);
  const ratio = (a, b, field) => {
    const on = spread(a.map(row => row[field])), off = spread(b.map(row => row[field]));
    return !on || !off || off.median === 0 ? null : on.median / off.median;
  };
  const comparisons = [];
  for (const factor of ['supervisor', 'memory']) for (const otherOn of [false, true]) {
    const other = factor === 'supervisor' ? 'memory' : 'supervisor';
    const off = balanced.filter(row => !row[factor] && row[other] === otherOn);
    const on = balanced.filter(row => row[factor] && row[other] === otherOn);
    const delta = on.filter(row => row.outcome === 'PASS').length - off.filter(row => row.outcome === 'PASS').length;
    const tokens = ratio(on, off, 'reportedTokens'), latency = ratio(on, off, 'wallMs');
    const lanesKnown = [...on, ...off].every(row => ['regression', 'scope'].every(lane =>
      checks[row.key]?.[lane] === 'PASS' || checks[row.key]?.[lane] === 'FAIL'));
    const newFailures = on.some(row => {
      const paired = off.find(base => base.task === row.task && base.repeat === row.repeat);
      return ['regression', 'scope'].some(lane => checks[row.key]?.[lane] === 'FAIL'
        && checks[paired?.key]?.[lane] !== 'FAIL');
    });
    const pending = [...on, ...off].some(row => row.outcome === 'BLOCKED' || row.outcome === 'SKIP');
    comparisons.push({ factor, other, otherOn, pairs: on.length, additionalPasses: delta,
      medianTokenRatio: tokens, medianSessionLatencyRatio: latency, lanesKnown, newFailures, pending,
      numericalThresholdMet: on.length > 0 && delta >= 2 && lanesKnown && !newFailures && !pending
        && results.ledger.unknownCalls === 0 && tokens !== null && tokens <= 1.25 && latency !== null && latency <= 1.25 });
  }
  return { all, balancedCount, balancedRounds: balancedCount / 32, partialRerun: balancedCount !== 96,
    partialObservations: results.completed.filter(row => Number(row.key.slice(0, 3)) > balancedCount),
    balancedGroups: summarize({ ...results, completed: balanced }).groups, comparisons,
    interpretation: 'Numerical thresholds alone do not prove benefit. Report interactions, actual intervention/retrieval use and the frozen E3 limitations; unknown or pending evidence cannot establish a win.' };
}

export async function readR17fSummary(root) {
  const results = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'));
  summarize(results); // validate keys before resolving their paths
  const checks = {};
  for (const row of results.completed) checks[row.key] = JSON.parse(await readFile(join(root, row.key, 'checks.json'), 'utf8'));
  return summarizeR17f(results, checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await readR17fSummary(resolve(process.argv[2])), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
