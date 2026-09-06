import { mkdir, realpath, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessEvent, type ModelProvider, type Pricing } from "@agentkitai/agentrig-core";
import type { ConfigValues } from "./config.js";
import { buildRoleProvider, resolveProviderEntries, type ProviderOptions } from "./provider.js";
import { readFixtureMap, validateEvaluationProfile, evaluatorPaths } from "./evaluation-fixtures.js";
import { evaluationTransport, prepareEvaluationWorkspace, verifyEvaluationSource, type EvaluationTransport } from "./evaluation-transport.js";
import { prepareEvaluationDependencies } from "./evaluation-preparation.js";
import { evaluationMemory } from "./evaluation-memory.js";
import { EvaluationBudget } from "./evaluation-budget.js";
import { runEvaluationAttempt, saveEvaluationArtifact } from "./evaluation-attempt.js";

export interface SessionEvaluationOptions {
  sessions: string[]; against: string; fixtures: string; output: string;
  profile: ConfigValues & { provider: string; model: string; modelExplicit?: boolean; providerOverride?: boolean }; execute?: boolean;
  batchTokens?: number; batchMinutes?: number; signal?: AbortSignal;
}
export interface SessionEvaluationDependencies {
  transport?: EvaluationTransport;
  provider?: (options: ProviderOptions, role: "main" | "supervisor") => Promise<ModelProvider>;
}

function evaluationPricing(values: ConfigValues): Pricing | undefined {
  const rates = [values.priceIn, values.priceOut, values.priceCacheRead, values.priceCacheWrite];
  if (rates.every(value => value === undefined)) {
    if (values.maxUsd !== undefined) throw new Error("evaluation maxUsd requires explicit pricing");
    return undefined;
  }
  // Full cache rates avoid guessing discounts when computing the shared monetary gate.
  if (rates.some(value => value === undefined)) throw new Error("evaluation pricing requires priceIn, priceOut, priceCacheRead and priceCacheWrite");
  return { inputUsdPerMTok: Number(values.priceIn), outputUsdPerMTok: Number(values.priceOut),
    cacheReadUsdPerMTok: Number(values.priceCacheRead), cacheWriteUsdPerMTok: Number(values.priceCacheWrite) };
}

export async function evaluateSessions(options: SessionEvaluationOptions, dependencies: SessionEvaluationDependencies = {}) {
  if (options.signal?.aborted) throw new Error("evaluation cancelled");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.against)) throw new Error("invalid evaluation profile name");
  if (!options.sessions.length || options.sessions.length > 16 || new Set(options.sessions).size !== options.sessions.length)
    throw new Error("evaluation requires one to sixteen unique session IDs");
  validateEvaluationProfile(options.profile);
  // Config's Zod output permits explicit undefined optional values; provider interfaces omit them.
  const providerOptions: ProviderOptions = { provider: options.profile.provider, model: options.profile.model,
    ...Object.fromEntries(Object.entries(options.profile).filter(([, value]) => value !== undefined)) };
  const identities = resolveProviderEntries(providerOptions);
  const pricing = evaluationPricing(options.profile);
  const mainIdentity = identities.entries[identities.roleNames.main]!;
  const supervisorIdentity = identities.entries[identities.roleNames.supervisor]!;
  if (pricing !== undefined && (mainIdentity.provider !== supervisorIdentity.provider || mainIdentity.model !== supervisorIdentity.model))
    throw new Error("evaluation flat pricing cannot price differing main/supervisor identities");
  const map = await readFixtureMap(options.fixtures);
  const rows = options.sessions.map(id => {
    const row = map.sessions.find(value => value.sessionId === id);
    if (!row) throw new Error("requested session has no explicit fixture mapping");
    return row;
  });
  const transport = dependencies.transport ?? evaluationTransport();
  for (const row of rows) {
    const task = await transport.task(row.task);
    if (row.report.startingRevision !== task.revision) throw new Error("baseline is not the pinned task revision");
    await verifyEvaluationSource(transport, row.source, task, options.signal);
    if ((options.profile.memory !== undefined) !== (row.memory !== undefined))
      throw new Error("evaluation memory profile requires an explicit matching frozen corpus mapping");
    if (row.memory !== undefined) {
      if (await realpath(options.profile.memory!) !== row.memory.path) throw new Error("evaluation memory profile/corpus path mismatch");
      await evaluationMemory(row.memory.path, row.memory.sha256);
    }
  }
  const preview = { version: 1, profile: options.against, execute: options.execute === true,
    workerImage: map.workerImage, checkerImage: map.checkerImage,
    tasks: rows.map(row => ({ sourceSessionId: row.sessionId, task: row.task, baselineOutcome: row.report.outcome,
      startingRevision: row.report.startingRevision, prerequisites: row.task.startsWith("A")
        ? "Requires matching offline dependency image; shipped worker cannot run A tasks alone."
        : "Shipped worker supports this pinned X task." })),
    comparison: "Mapped independent outcome comparison, not historical replay or a proven profile-only delta. Baseline worker/checker image identities are not attested by legacy E2 manifests.",
    limits: "Reported-token and explicitly priced scheduling guards; not a hard remote billing cap. In-flight requests/retries may exceed guards; unknown usage stops further scheduling.",
  };
  if (options.execute !== true) return { ...preview, results: [] };
  if (options.batchTokens === undefined || options.batchMinutes === undefined)
    throw new Error("--execute requires explicit --batch-tokens and --batch-minutes");
  const ledger = new EvaluationBudget(options.batchTokens, options.batchMinutes, options.signal,
    pricing === undefined ? undefined : { pricing, ...(options.profile.maxUsd === undefined ? {} : { maxUsd: Number(options.profile.maxUsd) }) });
  try {
    ledger.guard();
    await transport.preflight([map.workerImage, map.checkerImage], ledger.controller.signal);
    const output = join(await realpath(dirname(resolve(options.output))), resolve(options.output).split(/[\\/]/).at(-1)!);
    await mkdir(output); // Exclusive output claim, never overwrite a previous run or source logs.
    await saveEvaluationArtifact(join(output, "protocol.json"), preview);
    const revision = await transport.command("git", ["rev-parse", "HEAD"], { cwd: dirname(evaluatorPaths.workspace), signal: ledger.controller.signal });
    if (revision.code !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) throw new Error("cannot identify evaluation coordinator revision");
    const results = [];
    const coordinatorId = randomUUID(); let seq = 0;
    for (const [ordinal, row] of rows.entries()) {
      const directory = join(output, `${String(ordinal + 1).padStart(2, "0")}-${row.task}`);
      await mkdir(directory);
      let attemptId: string = randomUUID();
      let phase = "scheduling";
      const before = ledger.tokens, beforeCalls = ledger.calls.length;
      try {
        ledger.guard();
        const task = await transport.task(row.task);
        phase = "workspace preparation";
        const receipt = await prepareEvaluationWorkspace(transport, row.task, row.source,
          join(output, `${String(ordinal + 1).padStart(2, "0")}-${row.task}-workspace`), ledger.controller.signal);
        attemptId = receipt.runId;
        await prepareEvaluationDependencies(transport, receipt, map.workerImage, directory, ledger.controller.signal);
        const memory = row.memory === undefined ? undefined : { directory: join(directory, "memory"), sha256: row.memory.sha256 };
        if (row.memory !== undefined) await evaluationMemory(row.memory.path, row.memory.sha256, memory!.directory);
        ledger.guard();
        phase = "provider construction";
        const makeProvider = dependencies.provider ?? buildRoleProvider;
        const main = await makeProvider(providerOptions, "main"), supervisor = await makeProvider(providerOptions, "supervisor");
        phase = "session, checks or reporting";
        const attempt = await runEvaluationAttempt({ directory, receipt, task, transport, ledger,
          profile: options.profile, main, supervisor, evaluatorRevision: revision.stdout.trim(),
          workerImage: map.workerImage, checkerImage: map.checkerImage,
          budget: { maxTurns: Number(options.profile.maxTurns ?? 24),
            maxTokens: Math.min(Number(options.profile.maxTokens ?? options.batchTokens), options.batchTokens - ledger.tokens),
            maxMinutes: Math.min(Number(options.profile.maxMinutes ?? options.batchMinutes), options.batchMinutes),
            ...(options.profile.maxUsd === undefined ? {} : { maxUsd: Number(options.profile.maxUsd) }) },
          ...(pricing === undefined ? {} : { pricing }), ...(memory === undefined ? {} : { memory }),
          maxTokensPerTurn: Number(options.profile.maxTokensPerTurn ?? 8192),
        });
        const result = HarnessEvent.parse({ type: "eval.result", sessionId: coordinatorId, seq: ++seq, ts: Date.now(),
          task: row.task, sourceSessionId: row.sessionId, runId: receipt.runId, profile: options.against,
          outcome: attempt.report.outcome, baselineOutcome: row.report.outcome, reportedTokens: ledger.tokens - before,
          usageComplete: ledger.calls.slice(beforeCalls).every(call => call.complete), totalCostUsd: attempt.report.totalCostUsd,
          advisoryPass: attempt.advisory?.pass ?? null });
        await appendFile(join(output, "evaluation.jsonl"), `${JSON.stringify(result)}\n`);
        results.push(result);
      } catch {
        // Never echo provider/process/path payloads, which may contain credentials or task data.
        const result = HarnessEvent.parse({ type: "eval.result", sessionId: coordinatorId, seq: ++seq, ts: Date.now(),
          task: row.task, sourceSessionId: row.sessionId, runId: attemptId, profile: options.against, outcome: "BLOCKED",
          baselineOutcome: row.report.outcome, reportedTokens: ledger.tokens - before,
          usageComplete: ledger.calls.slice(beforeCalls).every(call => call.complete), totalCostUsd: null, advisoryPass: null });
        await saveEvaluationArtifact(join(directory, "blocked.json"), { ...result,
          phase,
          reason: "Preparation, execution, cancellation or accounting gate failed; inspect retained local artifacts.",
          runIdMeaning: "Actual E1 receipt ID if prepared; otherwise a coordinator-owned unstarted attempt ID." });
        await appendFile(join(output, "evaluation.jsonl"), `${JSON.stringify(result)}\n`);
        results.push(result);
      }
    }
    const summary = { ...preview, results, tokens: ledger.tokens, unknownCalls: ledger.unknownCalls,
      outcomes: { PASS: results.filter(row => row.type === "eval.result" && row.outcome === "PASS").length,
        FAIL: results.filter(row => row.type === "eval.result" && row.outcome === "FAIL").length,
        BLOCKED: results.filter(row => row.type === "eval.result" && row.outcome === "BLOCKED").length,
        SKIP: results.filter(row => row.type === "eval.result" && row.outcome === "SKIP").length },
      reportedUsd: pricing === undefined ? null : ledger.reportedUsd, cancelled: ledger.controller.signal.aborted };
    await saveEvaluationArtifact(join(output, "calls.json"), ledger.calls);
    await saveEvaluationArtifact(join(output, "summary.json"), summary);
    return summary;
  } finally { ledger.close(); }
}
