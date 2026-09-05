// Read-only E3 summary. Missing/pending outcomes stay visible; no model/human verdicts invented.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { schedule } from './live-support.mjs';

const { z } = createRequire(new URL('../packages/cli/package.json', import.meta.url))('zod');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Results = z.object({
  ledger: z.object({ startedAt: count, tokens: count, unknownCalls: count.optional(), blocked: z.string().nullable() }).strict(),
  planned: z.literal(96),
  completed: z.array(z.object({ key: z.string().regex(/^\d{3}-(?:A|X)[1-4]-s[01]m[01]-r[1-3]$/),
    task: z.enum(['A1', 'A2', 'A3', 'A4', 'X1', 'X2', 'X3', 'X4']), repeat: z.number().int().min(1).max(3), position: z.number().int().min(0).max(3),
    supervisor: z.boolean(), memory: z.boolean(), outcome: z.enum(['PASS', 'FAIL', 'BLOCKED', 'SKIP']), reportedTokens: count, wallMs: count }).strict()).max(96),
}).strict();

export function spread(values) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b), mid = Math.floor(xs.length / 2);
  return { n: xs.length, min: xs[0], median: xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, max: xs.at(-1) };
}
export function summarize(results) {
  results = Results.parse(results);
  const planned = schedule();
  const seen = new Set();
  for (const row of results.completed) {
    const ordinal = Number(row.key.slice(0, 3)), expected = planned[ordinal - 1];
    if (!expected || seen.has(ordinal) || ['task', 'repeat', 'position', 'supervisor', 'memory'].some(k => row[k] !== expected[k]))
      throw new Error('duplicate or mismatched scheduled result');
    const key = `${String(ordinal).padStart(3, '0')}-${row.task}-s${+row.supervisor}m${+row.memory}-r${row.repeat}`;
    if (key !== row.key) throw new Error('result key mismatch');
    seen.add(ordinal);
  }
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
