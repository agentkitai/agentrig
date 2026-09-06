// Scripted structural regression, not a live evaluation or product provider entry point.
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionStore } from '../packages/core/dist/index.js';
import { evaluateSessions } from '../packages/cli/dist/session-evaluation.js';
import { evaluationTransport, prepareEvaluationWorkspace } from '../packages/cli/dist/evaluation-transport.js';
import { readEvaluationReport } from '../packages/cli/dist/evaluation.js';
import { tasks, IS_NUMBER_REVISION } from './tasks.mjs';
import { fix, broken, investigation, scriptedProvider } from './scripted-fixtures.mjs';
import { retainNightlyArtifacts } from './nightly-artifacts.mjs';

export const NIGHTLY_CASES = Object.freeze([
  { name: 'correct', task: 'X1', expected: 'PASS', script: fix },
  { name: 'broken', task: 'X1', expected: 'FAIL', script: broken },
  { name: 'human-pending', task: 'X4', expected: 'BLOCKED', script: investigation },
]);
const save = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const evaluatorRoot = fileURLToPath(new URL('..', import.meta.url));

export function assertNightlyOutcome(test, result, report, checks) {
  if (result?.results?.length !== 1 || result.cancelled || result.unknownCalls !== 0
    || result.evidenceLane !== 'scripted' || result.results[0].outcome !== test.expected
    || result.results[0].task !== test.task || result.results[0].usageComplete !== true
    || report.evidenceLane !== 'scripted' || report.outcome !== test.expected || report.task !== test.task
    || checks.outcome !== test.expected || checks.task !== test.task)
    throw new Error('nightly outcome discriminator failed');
  if (test.name === 'human-pending' && (checks.manual !== 'PENDING' || checks.behavior !== 'PASS'
    || checks.regression !== 'PASS' || checks.scope !== 'PASS')) throw new Error('human gate not exercised');
}

async function baseline(work, source, task, transport, images, revision, signal) {
  const directory = join(work, `baseline-${task}`); await mkdir(directory);
  const receipt = await prepareEvaluationWorkspace(transport, task, source, join(work, `baseline-${task}-workspace`), signal);
  const edited = await transport.worker({ image: images.workerImage, workspace: receipt.workspace },
    ['/bin/sh', '-c', `node -e ${JSON.stringify(task === 'X1' ? fix : investigation)}`], signal, 60_000);
  if (edited.infrastructure || edited.code !== 0) throw new Error('baseline fixture failed');
  const checkerReceipt = join(directory, 'checker-receipt.json');
  const { receiptPath: _receiptPath, ...portable } = receipt;
  await save(checkerReceipt, { ...portable, workspace: '/workspace' });
  const checked = await transport.worker({ image: images.checkerImage, workspace: receipt.workspace, checkerReceipt },
    ['node', '/evaluator/eval/check.mjs', '/receipt.json'], signal, 300_000);
  await save(join(directory, 'checker-process.json'), checked);
  const checks = JSON.parse(checked.stdout);
  if (checked.infrastructure || checked.code !== (task === 'X1' ? 0 : 2)
    || checks.runId !== receipt.runId || checks.task !== task || checks.outcome !== (task === 'X1' ? 'PASS' : 'BLOCKED'))
    throw new Error('baseline checks failed');
  await save(join(directory, 'checks.json'), checks);
  const id = `scripted-baseline-${task}`, store = new SessionStore({ root: directory });
  // Explicitly synthetic fixture identity; never pretends to be a historic user's session.
  await store.append(id, { type: 'session.start', task: 'Scripted baseline fixture identity, not a model attempt',
    cwd: source, provider: 'scripted-fixture', model: 'mechanics-only' });
  await store.append(id, { type: 'session.end', reason: 'done' });
  await save(join(directory, 'manifest.json'), { version: 1, runId: receipt.runId, task,
    evaluatorRevision: revision, startingRevision: IS_NUMBER_REVISION, evidenceLane: 'scripted',
    configuration: { supervisor: false, memory: false, memoryCorpusSha256: null, budgets: {},
      roles: [{ role: 'main', provider: 'scripted-fixture', model: 'mechanics-only' }] },
    logs: [{ path: `${id}.jsonl`, sessionId: id, role: 'main' }], checks: 'checks.json',
    coverage: { sessionLogsComplete: true, auxiliaryComplete: true, externalCostsUsd: 0,
      evidence: ['Synthetic baseline identity plus actual E1 fixture checks; no provider work.'] },
    timing: { startedAt: 0, settledAt: Date.now(), includesObserverAndMaintenance: true,
      evidence: 'Synthetic identity, not a task-duration measurement.' },
    changes: { independentlyChecked: true, unintended: [], evidence: 'Actual E1 scope checks.' },
  });
  await readEvaluationReport(join(directory, 'manifest.json'));
  const map = join(work, `map-${task}.json`);
  await save(map, { version: 1, ...images, sessions: [{ sessionId: id, task, source, baseline: join(directory, 'manifest.json') }] });
  return { id, map };
}

/** Dependencies are trusted test transport only; no CLI/config can install code or change cases. */
export async function runNightly(options, dependencies = {}) {
  if (!imagePattern.test(options.workerImage) || !imagePattern.test(options.checkerImage)) throw new Error('pinned local images required');
  const output = join(await realpath(dirname(resolve(options.output))), resolve(options.output).split(/[\\/]/).at(-1));
  await mkdir(output); // Create-only. Refuse occupied destinations without changing them.
  const artifacts = join(output, 'artifacts'), work = join(output, 'work');
  await mkdir(artifacts); await mkdir(work);
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 10 * 60_000);
  const transport = dependencies.transport ?? evaluationTransport();
  const summary = { version: 1, lane: 'scripted-structure', status: 'RUNNING', phase: 'preflight',
    claim: 'Mechanics only; not task success, model quality, or an E3 live result.',
    evaluatorRevision: null, workerImage: options.workerImage, checkerImage: options.checkerImage,
    taskDefinitions: Object.entries(tasks).map(([id, task]) => ({ id, revision: task.revision,
      coverage: 'Existing E1/E2 structural tests run separately; not an isolated task attempt.' })),
    cases: NIGHTLY_CASES.map(test => ({ name: test.name, task: test.task, expected: test.expected, observed: null })),
    structuralTests: 'See separate E1/E2/R13e test report; wrapper success does not attest that test invocation.',
    cancelled: false, artifacts: null };
  const summaryPath = join(artifacts, 'nightly-summary.json');
  await save(summaryPath, summary);
  try {
    if (controller.signal.aborted) throw new Error('cancelled');
    await transport.preflight([options.workerImage, options.checkerImage], controller.signal);
    const revision = await transport.command('git', ['rev-parse', 'HEAD'], { cwd: evaluatorRoot, signal: controller.signal, ownedTree: true });
    if (revision.infrastructure || revision.code !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) throw new Error('revision unavailable');
    summary.evaluatorRevision = revision.stdout.trim(); summary.phase = 'source preparation';
    const source = join(work, 'source');
    const cloned = await transport.command('git', ['clone', '--quiet', '--branch', 'fixture',
      fileURLToPath(new URL('./fixtures/is-number-pinned.bundle', import.meta.url)), source], { signal: controller.signal, ownedTree: true });
    if (cloned.infrastructure || cloned.code !== 0) throw new Error('fixture clone failed');
    const baselines = new Map();
    for (const [index, test] of NIGHTLY_CASES.entries()) {
      if (controller.signal.aborted) throw new Error('cancelled');
      summary.phase = `${test.name}: baseline`;
      if (!baselines.has(test.task)) baselines.set(test.task, await baseline(work, source, test.task, transport,
        { workerImage: options.workerImage, checkerImage: options.checkerImage }, summary.evaluatorRevision, controller.signal));
      const fixture = baselines.get(test.task); summary.phase = `${test.name}: evaluation`;
      const result = await (dependencies.evaluate ?? evaluateSessions)({ sessions: [fixture.id], against: test.name,
        fixtures: fixture.map, output: join(work, test.name), execute: true, batchTokens: 10_000, batchMinutes: 2,
        signal: controller.signal, profile: { provider: 'openai', model: 'scripted-fixture', maxTurns: '4', maxTokensPerTurn: '2000' } },
      { transport, evidenceLane: 'scripted', provider: async (_options, role) => scriptedProvider(test.script, role) });
      summary.cases[index].observed = result.results?.[0]?.outcome ?? null;
      const directory = join(work, test.name, `01-${test.task}`);
      const report = await readEvaluationReport(join(directory, 'manifest.json'));
      const checks = JSON.parse(await readFile(join(directory, 'checks.json'), 'utf8'));
      assertNightlyOutcome(test, result, report, checks);
      await save(summaryPath, summary);
    }
    summary.status = 'PASS'; summary.phase = 'complete';
  } catch { summary.status = 'FAIL'; /* Keep bounded phase, never echo arbitrary error/env/process text. */ }
  finally {
    // All awaited evaluation/transport calls settle before evidence publication, including abort cleanup.
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    summary.cancelled = controller.signal.aborted;
    const selections = ['baseline-X1', 'baseline-X4'];
    for (const test of NIGHTLY_CASES) {
      selections.push(`${test.name}/01-${test.task}`);
      for (const file of ['protocol.json', 'summary.json', 'calls.json', 'evaluation.jsonl', `01-${test.task}-workspace.receipt.json`])
        selections.push(`${test.name}/${file}`);
    }
    summary.artifacts = await retainNightlyArtifacts(work, artifacts, selections);
    if (!summary.artifacts.complete || summary.cancelled) summary.status = 'FAIL';
    await save(summaryPath, summary);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (process.argv.length !== 5) throw new Error('arguments');
    const summary = await runNightly({ output: process.argv[2], workerImage: process.argv[3], checkerImage: process.argv[4], signal: controller.signal });
    console.log(JSON.stringify(summary)); process.exitCode = summary.status === 'PASS' ? 0 : 1;
  } catch { console.error('Nightly structure run refused or failed; inspect retained artifacts if created. Usage: node eval/nightly.mjs NEW_OUTPUT WORKER_SHA256 CHECKER_SHA256'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
