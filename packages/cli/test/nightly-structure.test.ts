import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSessions } from "../src/session-evaluation.js";
import { evaluationTransport, type EvaluationTransport } from "../src/evaluation-transport.js";

interface Summary { status: string; phase: string; cancelled: boolean; cases: Array<{ observed: string | null }>;
  artifacts: { complete: boolean; bytes: number; files: Array<{ path: string; sha256: string }>; missing: string[] } }
const nightlyUrl = new URL("../../../eval/nightly.mjs", import.meta.url).href;
const { runNightly, assertNightlyOutcome } = await import(nightlyUrl) as {
  runNightly(options: { output: string; workerImage: string; checkerImage: string; signal?: AbortSignal },
    deps?: { transport?: EvaluationTransport; evaluate?: typeof evaluateSessions }): Promise<Summary>;
  assertNightlyOutcome(test: { name: string; task: string; expected: string }, result: unknown, report: unknown, checks: unknown): void;
};
const { retainNightlyArtifacts } = await import(new URL("../../../eval/nightly-artifacts.mjs", import.meta.url).href) as {
  retainNightlyArtifacts(work: string, destination: string, selections: string[], limits?: { entries?: number; bytes?: number; fileBytes?: number }): Promise<Summary["artifacts"]>;
};
const image = `sha256:${"1".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-nightly-"))); roots.push(root); return root; }
const options = (root: string) => ({ output: join(root, "run"), workerImage: image, checkerImage: image });

/** Trusted actual host E1/checker fixture transport, explicitly not portable OS isolation. */
function transport(): EvaluationTransport {
  const base = evaluationTransport();
  return { ...base, preflight: async () => {}, async worker(options, args, signal, timeout) {
    if (options.checkerReceipt !== undefined) {
      const receipt = JSON.parse(await readFile(options.checkerReceipt, "utf8"));
      const path = `${options.checkerReceipt}.trusted-test.json`;
      await writeFile(path, JSON.stringify({ ...receipt, workspace: options.workspace }), { flag: "wx" });
      return base.command(process.execPath, [fileURLToPath(new URL("../../../eval/check.mjs", import.meta.url)), path], { signal, timeout });
    }
    expect(args[0]).toBe("/bin/sh"); expect(args[2]).toMatch(/^node -e /);
    return base.command(process.execPath, ["-e", JSON.parse(args[2]!.slice(8))], { cwd: options.workspace, signal, timeout });
  } };
}

it("requires exact positive/negative outcomes, complete usage and a genuinely pending human gate", () => {
  for (const [name, task, expected] of [["correct", "X1", "PASS"], ["broken", "X1", "FAIL"], ["human-pending", "X4", "BLOCKED"]]) {
    const test = { name: name!, task: task!, expected: expected! };
    const result = { results: [{ outcome: expected, task, usageComplete: true }], cancelled: false, unknownCalls: 0, evidenceLane: "scripted" };
    const report = { task, outcome: expected, evidenceLane: "scripted" };
    const checks = { task, outcome: expected, manual: "PENDING", behavior: "PASS", regression: "PASS", scope: "PASS" };
    expect(() => assertNightlyOutcome(test, result, report, checks)).not.toThrow();
    for (const changed of [{ ...result, results: [] }, { ...result, unknownCalls: 1 }, { ...result, cancelled: true },
      { ...result, results: [{ outcome: expected === "PASS" ? "BLOCKED" : "PASS", task, usageComplete: true }] }])
      expect(() => assertNightlyOutcome(test, changed, report, checks)).toThrow();
    expect(() => assertNightlyOutcome(test, result, { ...report, evidenceLane: "live" }, checks)).toThrow();
    if (name === "human-pending") expect(() => assertNightlyOutcome(test, result, report, { ...checks, manual: "NOT_REQUIRED" })).toThrow();
  }
});

it("actual portable core/E1/E2 wrapper retains three discriminating scripted reports, no workspace traversal", async () => {
  const root = await fixture();
  const result = await runNightly(options(root), { transport: transport() });
  expect(result.status).toBe("PASS");
  expect(result.cases.map(test => test.observed)).toEqual(["PASS", "FAIL", "BLOCKED"]);
  expect(result.artifacts.complete).toBe(true); expect(result.artifacts.bytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.artifacts.files.some(file => file.path.includes("workspace/"))).toBe(false);
  expect(result.artifacts.files.some(file => file.path.endsWith("manifest.json"))).toBe(true);
  const artifactRoot = join(root, "run", "artifacts");
  for (const name of ["correct", "broken", "human-pending"]) {
    const task = name === "human-pending" ? "X4" : "X1";
    const report = JSON.parse(await readFile(join(artifactRoot, name, `01-${task}`, "report.json"), "utf8"));
    expect(report.evidenceLane).toBe("scripted");
    expect(report.configuration.roles.every((role: { provider: string }) => role.provider === "scripted-fixture")).toBe(true);
  }
  expect(JSON.parse(await readFile(join(artifactRoot, "human-pending", "01-X4", "checks.json"), "utf8")).manual).toBe("PENDING");
}, 60_000);

it("retains bounded partial evidence and refuses linked, traversal or oversized selections", async () => {
  const root = await fixture(), work = join(root, "work"); await mkdir(work);
  await mkdir(join(work, "selected")); await writeFile(join(work, "selected", "report.json"), "{}");
  const copied = await retainNightlyArtifacts(work, join(root, "good"), ["selected"]);
  expect(copied.complete).toBe(true); expect(copied.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await retainNightlyArtifacts(work, join(root, "oversized"), ["selected"], { fileBytes: 1 })).complete).toBe(false);
  expect((await retainNightlyArtifacts(work, join(root, "byte-cap"), ["selected"], { bytes: 1 })).complete).toBe(false);
  expect((await retainNightlyArtifacts(work, join(root, "entry-cap"), ["selected"], { entries: 1 })).complete).toBe(false);
  expect((await retainNightlyArtifacts(work, join(root, "traversal"), ["../secret"])).complete).toBe(false);
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "secret.json"), "do-not-copy");
  await symlink(outside, join(work, "alias"), process.platform === "win32" ? "junction" : "dir");
  expect((await retainNightlyArtifacts(work, join(root, "linked"), ["alias/secret.json"])).complete).toBe(false);
  await expect(readFile(join(root, "linked", "alias", "secret.json"))).rejects.toThrow();
  await symlink(outside, join(root, "target-alias"), process.platform === "win32" ? "junction" : "dir");
  expect((await retainNightlyArtifacts(work, join(root, "target-alias"), ["selected"])).complete).toBe(false);
});

it("a missing selected accounting artifact fails even when actual checks pass", async () => {
  const root = await fixture();
  const result = await runNightly(options(root), { transport: transport(), evaluate: async (options, dependencies) => {
    const evaluated = await evaluateSessions(options, dependencies);
    await unlink(join(options.output, "calls.json"));
    return evaluated;
  } });
  expect(result.cases.map(test => test.observed)).toEqual(["PASS", "FAIL", "BLOCKED"]);
  expect(result.status).toBe("FAIL"); expect(result.artifacts.missing).toContain("correct/calls.json");
}, 60_000);

it("refuses occupied outputs and records missing infrastructure as failure without starting providers", async () => {
  const root = await fixture(); await mkdir(join(root, "run")); await writeFile(join(root, "run", "sentinel"), "human");
  await expect(runNightly(options(root))).rejects.toThrow();
  expect(await readFile(join(root, "run", "sentinel"), "utf8")).toBe("human");
  const result = await runNightly({ ...options(root), output: join(root, "refused") }, {
    transport: { ...transport(), preflight: async () => { throw new Error("secret-canary-must-not-leak"); } },
    evaluate: async () => { throw new Error("must not reach evaluator"); },
  });
  expect(result.status).toBe("FAIL"); expect(result.phase).toBe("preflight");
  const summary = await readFile(join(root, "refused", "artifacts", "nightly-summary.json"), "utf8");
  expect(summary).not.toContain("secret-canary"); expect(result.cases.every(test => test.observed === null)).toBe(true);
});

it("cancellation waits for the owned transport to settle before publishing a terminal partial summary", async () => {
  const root = await fixture(), controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const settled = new Promise<void>(resolve => { release = resolve; });
  const running = runNightly({ ...options(root), signal: controller.signal }, { transport: {
    ...transport(), preflight: async () => { entered(); await settled; throw new Error("owned cleanup complete"); },
  } });
  await ready; controller.abort();
  try { expect(JSON.parse(await readFile(join(root, "run", "artifacts", "nightly-summary.json"), "utf8")).status).toBe("RUNNING"); }
  finally { release(); }
  expect(await running).toMatchObject({ status: "FAIL", cancelled: true, phase: "preflight" });
});

it("a config cannot select evidence provenance and invalid trusted lane refuses before execution", async () => {
  await expect(evaluateSessions({ sessions: ["fixture"], against: "fixture", fixtures: "absent", output: "absent",
    profile: { provider: "openai", model: "fixture" } }, { evidenceLane: "forged" as never })).rejects.toThrow("invalid evaluation evidence lane");
});

it.runIf(process.env.AGENTRIG_EVAL_WORKER_IMAGE !== undefined || process.env.AGENTRIG_EVAL_REQUIRE_DOCKER === "1")(
  "actual nightly CLI requires its real Linux containers and retains PASS/FAIL/human-BLOCKED evidence", async () => {
    expect(process.platform).toBe("linux");
    const root = await fixture();
    const result = await evaluationTransport().command(process.execPath, [fileURLToPath(new URL("../../../eval/nightly.mjs", import.meta.url)),
      join(root, "cli"), process.env.AGENTRIG_EVAL_WORKER_IMAGE!, process.env.AGENTRIG_EVAL_CHECKER_IMAGE!], { timeout: 90_000, ownedTree: true });
    expect(result.infrastructure, result.stderr).toBe(false); expect(result.code, result.stdout).toBe(0);
    const report = JSON.parse(await readFile(join(root, "cli", "artifacts", "nightly-summary.json"), "utf8"));
    expect(report.cases.map((test: { observed: string }) => test.observed)).toEqual(["PASS", "FAIL", "BLOCKED"]);
    expect(report.taskDefinitions).toHaveLength(8); expect(report.lane).toBe("scripted-structure");
  }, 100_000);
