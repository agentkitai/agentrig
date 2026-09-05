// Read-only E3 summary. Missing/pending outcomes stay visible; no model/human verdicts invented.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schedule } from './live-support.mjs';

export function spread(values) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b), mid = Math.floor(xs.length / 2);
  return { n: xs.length, min: xs[0], median: xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, max: xs.at(-1) };
}
export function summarize(results) {
  const groups = [];
  for (const supervisor of [false, true]) for (const memory of [false, true]) {
    const rows = results.completed.filter(r => r.supervisor === supervisor && r.memory === memory);
    groups.push({ supervisor, memory, planned: 24, completed: rows.length,
      outcomes: Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'SKIP'].map(k => [k, rows.filter(r => r.outcome === k).length])),
      notRun: 24 - rows.length, reportedTokens: spread(rows.map(r => r.reportedTokens)), wallMs: spread(rows.map(r => r.wallMs)) });
  }
  return { planned: schedule().length, completed: results.completed.length, ledger: results.ledger, groups,
    conclusion: 'No benefit claim until independent checks, human gates and preregistered paired comparisons are complete.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(summarize(JSON.parse(await readFile(join(resolve(process.argv[2]), 'results.json'), 'utf8'))), null, 2));
}
