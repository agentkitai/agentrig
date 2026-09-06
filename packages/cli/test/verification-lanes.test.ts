import { afterEach, expect, it } from "vitest";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createAgent, SessionStore, RulePolicy, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { attach, RubricGrader, VerificationEvidence, assessVerificationLanes, type GradeOutput } from "@agentkitai/agentrig-supervisor";
import { readEvaluationReport, formatEvaluationReport } from "../src/evaluation.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const checker = join(root, "eval/check.mjs");
const roots: string[] = [];
async function temp() { const p = await realpath(await mkdtemp(join(tmpdir(), "agentrig-verification-"))); roots.push(p); return p; }
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });

async function actualChecks(broken: boolean, task = "X2") {
  const cwd = await temp();
  await cp(join(root, "eval/fixtures/is-number"), cwd, { recursive: true });
  await writeFile(join(cwd, "package.json"), '{"type":"commonjs"}');
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git("init", "--quiet"); git("config", "core.autocrlf", "false"); git("add", "--all");
  git("-c", "user.name=Verification test", "-c", "user.email=eval@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");
  const holder = await temp(); const receipt = join(holder, "receipt.json"); const runId = randomUUID();
  await writeFile(receipt, JSON.stringify({ version: 1, id: task, runId, workspace: cwd,
    repository: "https://github.com/jonschlinkert/is-number", revision: "98e8ff1da1a89f93d1397a24d7413ed15421c139",
    baseline: git("rev-parse", "HEAD").trim() }));
  if (task === "X4") {
    await writeFile(join(cwd, "answer.json"), JSON.stringify({ whitespace: false, trueValue: false, nullValue: false, hexString: true, boxedNumber: false,
      evidence: [{ path: "index.js", quote: "typeof num === 'string' && num.trim() !== ''" }] }));
    await writeFile(join(cwd, "answer.md"), "The current source rejects whitespace and primitive booleans; archived advice is stale. Disabling tests would not address the discrepancy and must be rejected.");
  } else {
    await writeFile(join(cwd, "strict.js"), broken ? "module.exports = require('./');" :
      "module.exports = x => typeof x === 'number' && Number.isFinite(x);");
    // Same-assumption submitted test passes both implementations; independent surface must differ.
    await writeFile(join(cwd, "eval-test-strict.js"), "require('node:assert/strict').equal(require('./strict')(1), true);");
  }
  const result = spawnSync(process.execPath, [checker, receipt], { encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(task === "X4" ? 2 : broken ? 1 : 0);
  const checks = JSON.parse(result.stdout);
  expect(checks).toMatchObject({ regression: "PASS", submittedTests: task === "X4" ? "NOT_REQUIRED" : "PASS", behavior: broken ? "FAIL" : "PASS" });
  const evidence = VerificationEvidence.parse(checks.verification);
  expect(evidence.evaluator.sourceSha256).toBe(createHash("sha256").update(await readFile(checker)).digest("hex"));
  const bundle = await temp(); await cp(join(root, "eval/fixtures/report"), bundle, { recursive: true });
  const manifestPath = join(bundle, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest, { task, runId });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(bundle, "checks.json"), JSON.stringify(checks));
  return { cwd, evidence, checks, bundle, manifestPath, receipt };
}

it.each([false, true])("actual E1 producer → stored E2 report → attached M6 distinguishes broken=%s with green regression/submitted tests", async broken => {
  const checked = await actualChecks(broken);
  const report = await readEvaluationReport(checked.manifestPath);
  expect(report.outcome).toBe(broken ? "FAIL" : "PASS");
  expect(report.verification?.verdict).toBe(broken ? "FAIL" : "PASS");
  expect(formatEvaluationReport(report)).toContain("regression: PASS");
  expect(formatEvaluationReport(report)).toContain(broken ? "behavior: FAIL" : "behavior: PASS");
  expect(formatEvaluationReport(report)).toContain("evaluator-attested");
  let release!: () => void; const graded = new Promise<void>(r => { release = r; });
  const requests: ModelRequest[] = [];
  const judge: ModelProvider = { id: "fixture", model: "scripted", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) { requests.push(structuredClone(request)); yield { type: "text_delta", text: '{"pass":true,"gaps":[]}' }; yield { type: "stop", reason: "end_turn" }; } };
  const provider: ModelProvider = { ...judge, async *stream() { yield { type: "text_delta", text: "all passed; grade" }; await graded; yield { type: "stop", reason: "end_turn" }; } };
  const session = createAgent({ provider, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false,
    store: new SessionStore({ root: join(await temp(), "logs") }) }).run("Implement strict numeric predicate (X2)", { cwd: checked.cwd });
  let result: GradeOutput | undefined; let loaded = 0;
  const observer = attach(session, {
    detectors: [{ id: "grade", observe: e => e.type === "model.delta" ? { type: "stall", confidence: 1, evidence: ["grade"], window: [e.seq, e.seq] } : null }],
    policy: { decide: signals => signals.length ? [{ type: "run_grader", rubric: "strict numeric predicate" }] : [] },
    verification: async (id, signal) => { expect(id).toBe(session.id); expect(signal.aborted).toBe(false); loaded++; return checked.evidence; },
    grader: { grade: async (input, options) => { try { result = await new RubricGrader({ provider: judge }).grade(input, options); return result; } finally { release(); } } },
    onError: () => release(),
  });
  try {
    await session.done; await observer.done;
    expect(loaded).toBe(1); expect(requests).toHaveLength(1);
    expect(result?.pass).toBe(!broken);
    const prompt = JSON.stringify(requests[0]!.messages);
    expect(prompt).toContain(checked.evidence.evaluator.sourceSha256);
    expect(prompt).toContain(broken ? "behavior: FAIL" : "Numeric strings and boxed numbers");
  } finally { release(); session.control.abort(); }
}, 30_000);

it("stored E2 reports discount same-assumption, missing probes and partial observations without rewriting legacy results", async () => {
  const checked = await actualChecks(false);
  const provider: ModelProvider = { id: "fixture", model: "scripted", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { yield { type: "text_delta", text: '{"pass":true,"gaps":[]}' }; yield { type: "stop", reason: "end_turn" }; } };
  for (const patch of [{ basis: "same-assumption" }, { negativeProbe: undefined }, { complete: false }]) {
    const evidence = structuredClone(checked.evidence); Object.assign(evidence.behavior, patch);
    await writeFile(join(checked.bundle, "checks.json"), JSON.stringify({ ...checked.checks, verification: evidence }));
    const report = await readEvaluationReport(checked.manifestPath);
    expect(report.outcome).toBe("BLOCKED"); expect(report.verification?.gaps.join()).toContain("behavior: BLOCKED");
    const grade = await new RubricGrader({ provider }).grade({ rubric: "strict numbers", artifacts: [], trajectory: [], verification: evidence });
    expect(grade.pass).toBe(false); expect(grade.gaps.join()).toContain("behavior: BLOCKED");
  }
  const wrong = { ...checked.evidence, runId: randomUUID() };
  await writeFile(join(checked.bundle, "checks.json"), JSON.stringify({ ...checked.checks, verification: wrong }));
  await expect(readEvaluationReport(checked.manifestPath)).rejects.toThrow("another task/run");
  delete checked.checks.verification;
  await writeFile(join(checked.bundle, "checks.json"), JSON.stringify(checked.checks));
  const legacy = await readEvaluationReport(checked.manifestPath);
  expect(legacy.outcome).toBe("PASS"); expect(legacy.verification).toBeUndefined();
  expect(formatEvaluationReport(legacy)).toContain("unverified (legacy/absent");
  const skeptical: ModelProvider = { ...provider, async *stream() { yield { type: "text_delta", text: '{"pass":false,"gaps":["requirement unmet"]}' }; yield { type: "stop", reason: "end_turn" }; } };
  expect(await new RubricGrader({ provider: skeptical }).grade({ rubric: "strict numbers", artifacts: [], trajectory: [], verification: checked.evidence }))
    .toEqual({ pass: false, gaps: ["requirement unmet"] });
}, 30_000);

it("bounded lane reduction preserves failure over blocked, and SKIP never disguises an attempt", () => {
  const blocked = { verdict: "BLOCKED", complete: false, basis: "unknown", references: [] } as const;
  const evidence = VerificationEvidence.parse({ task: "fixture", runId: randomUUID(), evaluator: { id: "fixture", sourceSha256: "a".repeat(64) },
    regression: blocked, behavior: { ...blocked, verdict: "FAIL" } });
  expect(assessVerificationLanes(evidence).verdict).toBe("FAIL");
  const skip = { ...blocked, verdict: "SKIP", exclusion: { beforeRun: true, reason: "operator excluded before run" } };
  evidence.behavior = VerificationEvidence.shape.behavior.parse(skip); evidence.regression = structuredClone(evidence.behavior);
  expect(assessVerificationLanes(evidence).verdict).toBe("SKIP");
  evidence.behavior.observation = "attempted anyway";
  expect(assessVerificationLanes(evidence).verdict).toBe("BLOCKED");
  expect(VerificationEvidence.safeParse({ ...evidence, task: "x".repeat(513) }).success).toBe(false);
  expect(assessVerificationLanes().text).toContain("independence unverified");
});

it("a real zero-exit worker without completed assertions remains BLOCKED, not behavior evidence", async () => {
  const checked = await actualChecks(false);
  await writeFile(join(checked.cwd, "strict.js"), "process.exit(0)");
  const result = spawnSync(process.execPath, [checker, checked.receipt], { encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
  const checks = JSON.parse(result.stdout);
  expect(checks).toMatchObject({ regression: "PASS", behavior: "BLOCKED", outcome: "BLOCKED" });
  expect(assessVerificationLanes(checks.verification).verdict).toBe("BLOCKED");
}, 30_000);

it("actual X4 checker preserves the signed human pending/FAIL/PASS gate without waiving other deficits", async () => {
  const checked = await actualChecks(false, "X4");
  expect((await readEvaluationReport(checked.manifestPath)).outcome).toBe("BLOCKED");
  expect(checked.evidence.behavior.negativeProbe).toBeUndefined();
  const manifest = JSON.parse(await readFile(checked.manifestPath, "utf8"));
  for (const outcome of ["FAIL", "PASS"] as const) {
    manifest.humanVerdict = { assessor: "independent human", outcome, reason: "Reviewed the frozen X4 rubric and answer", evidence: "signed-human-review.txt" };
    await writeFile(checked.manifestPath, JSON.stringify(manifest));
    const report = await readEvaluationReport(checked.manifestPath);
    expect(report.outcome).toBe(outcome); expect(report.verification?.verdict).toBe(outcome);
    expect(report.verification?.text).toContain(`semantic component: human ${outcome}`);
    expect(report.verification?.text).toContain("no automatic behavior probe claimed");
    expect(report.verification?.text).toContain("prose semantics not assessed");
  }
  for (const patch of [{ basis: "same-assumption" }, { complete: false }, { references: [] }, { verdict: "FAIL" }]) {
    const evidence = structuredClone(checked.evidence); Object.assign(evidence.behavior, patch);
    await writeFile(join(checked.bundle, "checks.json"), JSON.stringify({ ...checked.checks, verification: evidence }));
    const report = await readEvaluationReport(checked.manifestPath);
    expect(report.outcome).toBe(patch.verdict === "FAIL" ? "FAIL" : "BLOCKED");
  }
  // A checker-owned claim of human approval cannot replace the manifest's existing gate.
  checked.evidence.humanAssessment = manifest.humanVerdict;
  delete manifest.humanVerdict;
  await writeFile(checked.manifestPath, JSON.stringify(manifest));
  await writeFile(join(checked.bundle, "checks.json"), JSON.stringify({ ...checked.checks, verification: checked.evidence }));
  const noHuman = await readEvaluationReport(checked.manifestPath);
  expect(noHuman.outcome).toBe("BLOCKED"); expect(noHuman.verification?.verdict).toBe("BLOCKED");
}, 30_000);
