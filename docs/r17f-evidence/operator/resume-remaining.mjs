// Operator continuation only: unchanged frozen runner, new evidence root, no retries.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { run, Settings, attemptKey, measurementSignals } from '/var/tmp/agentrig-r17f/eval/r17f.mjs';
import { summarize } from '/var/tmp/agentrig-r17f/eval/summarize-live.mjs';
import { schedule } from '/var/tmp/agentrig-r17f/eval/live-support.mjs';

const work = '/var/tmp/agentrig-r17f-work.ZhA9M7';
const oldRoot = `${work}/live-r17f-corrected-20260909`;
const newRoot = `${work}/live-r17f-continuation-20260909`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function continuationPlan(results, calls, directories, protocol) {
  summarize(results);
  if (protocol.revision !== '4d41826a0ba064e67dead46125aa6a64e34426b6') throw new Error('unexpected frozen revision');
  if (results.completed.length !== 51 || results.ledger.tokens !== 6312295 || results.ledger.unknownCalls !== 1
    || results.ledger.blocked !== 'evaluation stopped: provider usage is incomplete') throw new Error('unexpected closed collection');
  const expected = schedule().slice(0, 51).map((config, ordinal) => attemptKey(ordinal, config));
  if (results.completed.some((row, i) => row.key !== expected[i])) throw new Error('noncontiguous completed schedule');
  const started = directories.filter(name => /^\d{3}-[AX][1-4]-s[01]m[01]-r[1-3]$/.test(name)).sort();
  if (JSON.stringify(started) !== JSON.stringify(expected)) throw new Error('unaccounted attempted slot');
  const unknown = calls.filter(call => !call.complete);
  if (unknown.length !== 1 || unknown[0].id !== '2cde70bd-cd20-4c0b-86e4-2e0d94230bf4'
    || unknown[0].endedAt === undefined || unknown[0].usage !== null) throw new Error('unexpected incomplete call');
  const authorizedTotal = 20000000, unknownReserve = 1178000, segmentCap = 12000000;
  if (results.ledger.tokens + unknownReserve + segmentCap > authorizedTotal) throw new Error('continuation exceeds authorization');
  return { slots: Array.from({ length: 45 }, (_, index) => index + 51), authorizedTotal,
    previousReportedTokens: results.ledger.tokens, previousUnknownCalls: 1, unknownReserve, segmentCap };
}

async function main() {
  const [resultsBytes, callsBytes, protocolBytes, directories] = await Promise.all([
    readFile(`${oldRoot}/results.json`), readFile(`${oldRoot}/calls.json`), readFile(`${oldRoot}/protocol.json`), readdir(oldRoot),
  ]);
  const protocol = JSON.parse(protocolBytes);
  const plan = continuationPlan(JSON.parse(resultsBytes), JSON.parse(callsBytes), directories, protocol);
  const settings = Settings.parse({ ...protocol.settings, output: newRoot, totalTokens: plan.segmentCap });
  const receipt = { recordedAt: new Date().toISOString(), kind: 'explicit-user-authorized-unattempted-slot-continuation',
    authorization: 'User raised corrected-run total to 20M and explicitly directed resumption after the incomplete-usage halt.',
    originalRoot: oldRoot, continuationRoot: newRoot, evaluatorRevision: protocol.revision,
    ...plan, originalHashes: { results: hash(resultsBytes), calls: hash(callsBytes), protocol: hash(protocolBytes) },
    operatorScriptSha256: hash(await readFile(new URL(import.meta.url))),
    limitations: 'Unknown consumption remains unknown, not zero. Reserve is scheduling only, not measured usage or a remote billing guarantee. Original 51 outcomes, including all failures, remain unchanged. No attempt or failed provider call is retried. Interrupted chronology remains disclosed; aggregate benefit analysis retains unknownCalls=1.',
    settings };
  await writeFile(`${work}/continuation-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  const controller = new AbortController(), dispose = measurementSignals(controller);
  try { await run(settings, { slots: plan.slots, signal: controller.signal }); }
  finally { dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
