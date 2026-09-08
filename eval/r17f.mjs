// R17f-only trusted orchestration: rerun the E3 matrix under today's R17b/R17d defaults with
// R17e's visible interventions. Not a product CLI, not a general sandbox, not a new evaluator.
// Everything measured here is assembled from existing product seams; E3's own runner
// (`eval/live.mjs`) and its published results are untouched.
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { OpenAIChatGPTProvider, OpenAIChatGPTAuth, PermissionGrantRegistry, GuidanceLog } from '../packages/core/dist/index.js';
import { FileMemoryStore, indexInjection, MEMORY_RECALL_TOOLS } from '../packages/memory/dist/index.js';
import { loadRunConfig } from '../packages/cli/dist/config.js';
import { buildPermissionPolicy } from '../packages/cli/dist/run.js';
import { R17fBudget } from './r17f-budget.mjs';
import { captureEvidence } from './r17f-evidence.mjs';
import { PRIMARY_TASKS } from './r17f-summary.mjs';
import { evaluationTransport, prepareEvaluationWorkspace, verifyEvaluationSource } from '../packages/cli/dist/evaluation-transport.js';
import { prepareEvaluationDependencies } from '../packages/cli/dist/evaluation-preparation.js';
import { evaluationMemory } from '../packages/cli/dist/evaluation-memory.js';
import { runEvaluationAttempt, saveEvaluationArtifact } from '../packages/cli/dist/evaluation-attempt.js';
import { TuiController } from '../packages/cli/dist/tui/controller.js';
import { AssistantText, AuxiliaryText, MemoryContextText, RecallText, renderChatEvent, renderWhy } from '../packages/cli/dist/render.js';
import { BUDGET, schedule, dockerRun } from './live-support.mjs';
import { E3_MODEL } from './live.mjs';
import { E3_CORPUS_SHA256 } from './r17f-corpus.mjs';

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { z } = require('zod');
const { Command } = require('commander');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Authorized R17f reserve: STATUS 1324/1353 and plans/R17b-outside-diagnostics.md. A reported-token
 * scheduling cap, never a guaranteed remote billing bound. */
export const R17F_TOTAL_TOKENS = 12_000_000;
export const REQUEST_TIMEOUT_MS = 60_000;
/** E3's outer allowance past the turn-boundary elapsed budget. */
export const HANG_GUARD_MS = BUDGET.maxMinutes * 60_000 + 90_000;

export const Settings = z.object({
  worker: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  checker: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source: z.string().min(1),
  memoryCorpus: z.string().min(1),
  output: z.string().min(1),
  // Pre-registered before collection; there is no default, because choosing one silently would
  // change which comparison this run makes.
  arm: z.enum(['heuristics', 'heuristics+llm']),
  dependencies: z.enum(['offline-image', 'network-prepare']),
  rounds: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  maxMinutes: z.number().int().min(1).max(1440),
  totalTokens: z.number().int().min(1).max(R17F_TOTAL_TOKENS),
}).strict();

/**
 * Today's zero-config defaults, read through the product's own resolution, not restated here.
 * An empty home and an untrusted empty cwd are what "a fresh clone with no config" means: no user
 * config, no project config, no environment model override, no credentials read.
 */
export async function measuredProfile(cwd, home, load = loadRunConfig) {
  const resolved = await load(new Command('run'), {}, { cwd, home, env: {}, interactive: false });
  const expected = { supervise: true, checkpoints: true, ingestOnEnd: true, notifications: 'bell', toolSummaries: true };
  const mismatched = Object.entries(expected).filter(([key, value]) => resolved[key] !== value);
  if (mismatched.length) throw new Error(`recommended defaults are not what R17f expects: ${JSON.stringify(mismatched)}`);
  if (resolved.supervisorReview === true || resolved.supervisorAbort === true)
    throw new Error('LLM review or automatic abort is on by default; R17f pre-registration assumed both are opt-in');
  return resolved;
}

/** The supervisor arm applied on top of the resolved profile. `heuristics` is today's default and
 * changes nothing; the LLM arm is an explicit, recorded deviation from the shipped default. */
export function armProfile(profile, arm) {
  if (arm === 'heuristics') return { profile, overrides: {} };
  const overrides = { supervisorReview: true };
  return { profile: { ...profile, ...overrides }, overrides };
}

/** Per-request bound; E3 used the same 60 seconds and no automatic retries. */
export function bounded(provider, timeoutMs = REQUEST_TIMEOUT_MS) {
  return { id: provider.id, model: provider.model, capabilities: provider.capabilities,
    async *stream(request, signal) {
      yield* provider.stream(request, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    } };
}

/**
 * R17d's frozen response policy, driven through the actual approval controller: confirm an offered
 * default scoped grant, otherwise allow once. Never allow-all, never a standing tool answer.
 * Serialized so a parallel tool batch cannot answer another request's open prompt.
 */
export function presetApprovals(controller, grants, signal) {
  const prompts = [];
  let queue = Promise.resolve();
  const ask = async (req, context) => {
    const answer = controller.ask(req, context, signal);
    const pending = controller.snapshot().pending;
    const mine = pending !== null && pending.req === req;
    let offered = false;
    if (mine) {
      controller.startDefaultPermissionScope();
      offered = controller.snapshot().pending?.scope?.preview === true;
      if (offered) controller.confirmPermissionScope();
      else {
        controller.cancelPermissionScope();
        controller.answerPermission('allow');
      }
    }
    const decision = await answer;
    prompts.push({ tool: req.tool, class: req.class, origin: req.origin ?? null,
      // A request resolved without an open prompt was covered by a scoped grant already confirmed
      // in this session. It is a consumed decision, not a new one a person answered.
      prompted: mine, scopedGrantOffered: offered, decision, grants: grants.list().length });
    return decision;
  };
  return { prompts, ask: (req, context) => { const next = queue.then(() => ask(req, context)); queue = next.then(() => {}, () => {}); return next; } };
}

/** The same composition headless `run` uses, so R17e's lines are the ones the evidence records. */
export function transcriber() {
  const assistant = new AssistantText(), auxiliary = new AuxiliaryText();
  const recall = new RecallText(), memoryContext = new MemoryContextText();
  const lines = [];
  return { lines, push(event) {
    for (const line of auxiliary.push(event)) lines.push(line);
    const reply = assistant.push(event);
    if (reply !== null) lines.push(reply);
    if (event.type === 'model.delta') return;
    for (const line of [...memoryContext.push(event), ...recall.push(event)]) lines.push(line);
    const line = renderChatEvent(event);
    if (line !== null) lines.push(line);
  } };
}

export function attemptKey(ordinal, config) {
  return `${String(ordinal + 1).padStart(3, '0')}-${config.task}-s${+config.supervisor}m${+config.memory}-r${config.repeat}`;
}

export async function run(settings, dependencies = {}) {
  const output = resolve(settings.output);
  await mkdir(output); // exclusive new evidence root; never resume or overwrite
  const transport = dependencies.transport ?? evaluationTransport();
  const makeProvider = dependencies.provider ?? (() => bounded(new OpenAIChatGPTProvider({
    ...E3_MODEL, auth: dependencies.auth ?? new OpenAIChatGPTAuth(), retry: { maxRetries: 0 } })));
  const ledger = new R17fBudget(settings.totalTokens, settings.maxMinutes, output);
  const completed = [];
  let blocked = null;
  try {
    const revision = await transport.command('git', ['rev-parse', 'HEAD'], { cwd: repo, timeout: 10_000 });
    const dirty = await transport.command('git', ['status', '--porcelain'], { cwd: repo, timeout: 10_000 });
    if (revision.code !== 0 || revision.infrastructure || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) throw new Error('cannot identify the frozen evaluator revision');
    if (dirty.code !== 0 || dirty.infrastructure) throw new Error('cannot verify the frozen evaluator is clean');
    if (dirty.stdout.trim() !== '') throw new Error('commit the frozen R17f evaluator before live runs');
    const home = join(output, 'config-home'), profileCwd = join(output, 'config-cwd');
    await mkdir(home); await mkdir(profileCwd);
    const resolved = await measuredProfile(profileCwd, home, dependencies.loadRunConfig);
    const { profile, overrides } = armProfile(resolved, settings.arm);
    const corpus = await evaluationMemory(settings.memoryCorpus, E3_CORPUS_SHA256);
    const all = schedule();
    // Balanced rounds of 32 in the fixed E3 order. `slots` is trusted test injection only: it
    // selects which preregistered slots run, and never renumbers or reorders them.
    const slots = dependencies.slots ?? Array.from({ length: settings.rounds * 32 }, (_, index) => index);
    if (slots.some(index => all[index] === undefined)) throw new Error('slot outside the preregistered schedule');
    await transport.preflight([settings.worker, settings.checker], ledger.controller.signal);
    for (const task of ['A1', 'A2', 'A3', 'A4', 'X1', 'X2', 'X3', 'X4']) {
      if (task.startsWith('X')) await verifyEvaluationSource(transport, settings.source, await transport.task(task), ledger.controller.signal);
    }
    await saveEvaluationArtifact(join(output, 'protocol.json'), {
      version: 1, row: 'R17f', revision: revision.stdout.trim(), node: process.version, platform: process.platform,
      model: { provider: 'openai-chatgpt', ...E3_MODEL, roles: ['main', 'supervisor'], subscriptionOnly: true, apiKeyFallback: false },
      settings: { ...settings, output }, arm: settings.arm, armOverrides: overrides,
      profile: resolved, profileSource: 'loadRunConfig with an empty home and an untrusted empty cwd',
      permissions: 'RulePolicy(defaultRules) with ask fallback, a real session grant registry, and R17d\'s frozen preset response policy',
      corpus: { sha256: corpus.sha256, files: corpus.files, bytes: corpus.bytes, origin: 'recovered from the published E3 evidence archive; no new training or ingest' },
      budget: { perAttempt: BUDGET, hangGuardMs: HANG_GUARD_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS,
        totalTokens: settings.totalTokens, maxMinutes: settings.maxMinutes,
        perInflightCallAdmissionHeadroom: ledger.headroom,
        note: 'Reported-token scheduling caps. An in-flight backend response can overshoot them; this is not a remote billing guarantee.' },
      schedule: { planned: slots.length, of: all.length, slots, rounds: settings.rounds, balancedBlock: 32,
        order: 'E3 Latin square, fixed before results; no outcome-driven retries or reordering' },
      analysis: { primaryTasks: PRIMARY_TASKS, primaryPairsPerComparisonAtFullMatrix: 18,
        minimumAdditionalPasses: 2, maximumMedianTokenRatio: 1.25, maximumMedianSessionLatencyRatio: 1.25,
        regressionAndScopeVeto: 'all eight tasks, including prose tasks',
        proseTasks: ['A4', 'X4'], proseAssessment: 'separate unmodified automatic outcomes; no invented human judgment',
        partial: 'largest complete 32-slot prefix; retain every partial-block observation separately' },
      controls: ['shell-only task tools plus update_plan, and memory_search/memory_read when memory is on',
        'frozen retrieval only: no held-out ingest, dream, learning or corpus edit',
        'no subagents, MCP, external memory backend or compaction',
        'minimal evaluator does not install diagnostic, checkpoint or session-end ingest hooks; their resolved defaults are recorded but not exercised',
        'independent E1 checks in a separate checker image decide every outcome'],
      limitations: ['This is not an interactive usability comparison; a shell-only worker cannot measure TUI rendering, prompt history, notifications or /why as a person would use them.',
        'Automatic A4/X4 human gates stay BLOCKED unless a separately attributed authorized assessment is supplied; no humanVerdict is written here.',
        "E3's collection limitations still apply, including the X4 training-description overlap and the A4 output-contract ambiguity."],
    });
    for (const ordinal of slots) {
      const config = all[ordinal];
      ledger.guard();
      // Re-verified before every attempt: a corpus that changed mid-run would silently make the
      // remaining memory-on cells a different experiment from the ones already collected.
      await evaluationMemory(settings.memoryCorpus, E3_CORPUS_SHA256);
      const key = attemptKey(ordinal, config);
      const directory = join(output, key);
      await mkdir(directory);
      await ledger.record({ phase: 'attempt-start', key, tokens: ledger.tokens });
      console.log(`START ${key} totalTokens=${ledger.tokens}`);
      const startedAt = Date.now(), before = ledger.tokens;
      const task = await transport.task(config.task);
      const receipt = await prepareEvaluationWorkspace(transport, config.task, config.task.startsWith('A') ? repo : settings.source,
        join(output, `${key}-workspace`), ledger.controller.signal);
      if (settings.dependencies === 'offline-image') {
        await prepareEvaluationDependencies(transport, receipt, settings.worker, directory, ledger.controller.signal);
      } else if (config.task.startsWith('A')) {
        // Explicitly declared fallback: preparation (not the model session) may use the network.
        const prep = await dockerRun({ image: settings.worker, workspace: receipt.workspace, network: true },
          ['/bin/sh', '-c', 'pnpm install --frozen-lockfile && pnpm build'], undefined, 240_000);
        await saveEvaluationArtifact(join(directory, 'dependency-preparation.json'), { ...prep, network: true });
        if (prep.code !== 0) throw new Error(`preparation failed: ${key}`);
      }
      const memory = config.memory ? { directory: join(directory, 'memory'), sha256: corpus.sha256 } : undefined;
      if (memory !== undefined) await evaluationMemory(settings.memoryCorpus, corpus.sha256, memory.directory);
      const index = memory === undefined ? '' : await indexInjection(new FileMemoryStore({ root: memory.directory }));
      const grants = new PermissionGrantRegistry();
      // The same binding the CLI makes at session start: a session-scoped grant belongs to this
      // attempt's session, and core refuses one made under a different session identity.
      grants.beginSession(receipt.runId);
      const controller = new TuiController({ cwd: receipt.workspace, permissionGrants: grants,
        build: () => { throw new Error('the R17f evaluator never submits TUI tasks'); } });
      const approvals = presetApprovals(controller, grants,
        AbortSignal.any([ledger.controller.signal, AbortSignal.timeout(HANG_GUARD_MS)]));
      const permissions = buildPermissionPolicy({ extra: memory === undefined ? []
        : [{ tool: 'memory_search', decision: 'allow' }, { tool: 'memory_read', decision: 'allow' }] });
      const transcript = transcriber(), guidance = new GuidanceLog();
      const attempt = await runEvaluationAttempt({
        directory, receipt, task, transport, ledger,
        // The supervisor factor is the documented explicit opt-out of today's default, applied on
        // top of the resolved profile; nothing else about the profile changes between cells.
        profile: { ...profile, supervise: config.supervisor },
        main: makeProvider('main'), supervisor: makeProvider('supervisor'),
        evaluatorRevision: revision.stdout.trim(), evidenceLane: 'live',
        workerImage: settings.worker, checkerImage: settings.checker,
        budget: { ...BUDGET }, maxTokensPerTurn: Number(profile.maxTokensPerTurn ?? 8192),
        ...(memory === undefined ? {} : { memory }),
        permissions, permissionGrants: grants, onAsk: approvals.ask,
        fileChanges: true, hangGuardMs: HANG_GUARD_MS, advisory: false,
        observe: event => { transcript.push(event); guidance.push(event); },
        onSessionSettled: async timing => {
          await saveEvaluationArtifact(join(directory, 'session-timing.json'), timing);
          await ledger.record({ phase: 'checker-start', key, tokens: ledger.tokens, sessionTiming: timing });
        },
      });
      await ledger.record({ phase: 'capture-start', key, tokens: ledger.tokens });
      await captureEvidence(transport, { image: settings.worker, workspace: receipt.workspace }, receipt, task, directory);
      await writeFile(join(directory, 'transcript.txt'), `${transcript.lines.join('\n')}\n`, { flag: 'wx' });
      await saveEvaluationArtifact(join(directory, 'why.json'), {
        rendered: renderWhy(guidance.explainLast({ recallTools: MEMORY_RECALL_TOOLS }), index === '' ? {} : { memoryIndex: index }),
        authority: 'local fold over this session\'s own events; not a provider call or a correctness claim' });
      await saveEvaluationArtifact(join(directory, 'permissions.json'), {
        policy: 'defaultRules with ask fallback', responsePolicy: 'R17d frozen preset: confirm an offered default scoped grant, otherwise allow once; never allow-all',
        prompts: approvals.prompts, grants: grants.list(), controllerLines: controller.snapshot().lines.map(line => line.text) });
      const row = { key, task: config.task, repeat: config.repeat, position: config.position,
        supervisor: config.supervisor, memory: config.memory, outcome: attempt.report.outcome,
        reportedTokens: ledger.tokens - before, wallMs: attempt.sessionTiming.settledAt - attempt.sessionTiming.startedAt };
      await saveEvaluationArtifact(join(directory, 'orchestration-timing.json'), {
        startedAt, settledAt: Date.now(), primarySessionTiming: attempt.sessionTiming,
        evidence: 'End-to-end includes preparation, independent checker and artifact capture; results.wallMs excludes those and measures session plus joined observer settlement.' });
      completed.push(row);
      await appendFile(join(output, 'attempts.jsonl'), `${JSON.stringify(row)}\n`);
      await ledger.record({ phase: 'attempt-settled', key, outcome: row.outcome, tokens: ledger.tokens });
      console.log(`DONE ${key} ${JSON.stringify(row)} totalTokens=${ledger.tokens}`);
    }
  } catch (error) {
    blocked = error.message;
    console.error(`BLOCKED ${blocked}`);
  } finally {
    try {
      await ledger.writes;
      // Preserve the E3-compatible all-slot record; R17f's primary subset is derived separately.
      await saveEvaluationArtifact(join(output, 'results.json'), {
        ledger: { startedAt: ledger.startedAt, tokens: ledger.tokens, unknownCalls: ledger.unknownCalls, blocked },
        planned: schedule().length, completed });
      await saveEvaluationArtifact(join(output, 'calls.json'), ledger.calls);
    } finally { ledger.close(); }
    if (blocked !== null) process.exitCode = 2;
  }
  return { completed, blocked, tokens: ledger.tokens, unknownCalls: ledger.unknownCalls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await run(Settings.parse(JSON.parse(await readFile(process.argv[2], 'utf8')))); }
  catch (error) { console.error(`BLOCKED: ${error.message}`); process.exitCode = 2; }
}
