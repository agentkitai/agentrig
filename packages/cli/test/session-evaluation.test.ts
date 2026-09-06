import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { SessionStore, type ModelProvider, type ModelEvent } from "@agentkitai/agentrig-core";
import { evaluateSessions } from "../src/session-evaluation.js";
import { evaluationTransport, prepareEvaluationWorkspace, type EvaluationTransport } from "../src/evaluation-transport.js";
import { EvaluationBudget } from "../src/evaluation-budget.js";
import { validateEvaluationProfile } from "../src/evaluation-fixtures.js";
import { prepareEvaluationDependencies } from "../src/evaluation-preparation.js";
import { evaluationMemory } from "../src/evaluation-memory.js";
import { buildProgram } from "../src/program.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const image = `sha256:${"1".repeat(64)}`;
const pin = "98e8ff1da1a89f93d1397a24d7413ed15421c139";
const bundle = fileURLToPath(new URL("../../../eval/fixtures/is-number-pinned.bundle", import.meta.url));
const profile = { provider: "openai" as const, model: "fixture", maxTurns: "4", maxTokensPerTurn: "2000" };
const fix = `const fs=require('fs');fs.writeFileSync('index.js',fs.readFileSync('index.js','utf8').replace("num !== ''","num.trim() !== ''"));fs.writeFileSync('eval-test-fix.js',"const assert=require('node:assert/strict');const f=require('./');assert.equal(f('   '),false);assert.equal(f(' 1 '),true);\\n");`;
const broken = `require('fs').writeFileSync('eval-test-broken.js',"require('node:assert/strict').equal(require('./')(1),true);\\n");`;

function fake(script: string, role: "main" | "supervisor", usage = true): ModelProvider {
  let calls = 0;
  return { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (role === "supervisor") yield { type: "text_delta", text: '{"pass":true,"gaps":[]}' };
      else if (calls++ === 0) yield { type: "tool_use", id: "edit", name: "bash", input: { command: `node -e ${JSON.stringify(script)}` } };
      else yield { type: "text_delta", text: "Completed." };
      if (usage) yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: role === "main" && calls === 1 ? "tool_use" : "end_turn" };
    } };
}

/** Actual E1/checker subprocesses over deliberately trusted fixtures; not an OS-isolation proof. */
function trustedTransport(): EvaluationTransport {
  const base = evaluationTransport();
  return { ...base, preflight: async () => {},
    async worker(options, args, signal, timeout) {
      if (options.checkerReceipt !== undefined) {
        const receipt = JSON.parse(await readFile(options.checkerReceipt, "utf8"));
        const local = `${options.checkerReceipt}.trusted-test.json`;
        await writeFile(local, JSON.stringify({ ...receipt, workspace: options.workspace }), { flag: "wx" });
        return base.command(process.execPath, [fileURLToPath(new URL("../../../eval/check.mjs", import.meta.url)), local], { signal, timeout });
      }
      if (args[0] === "/bin/sh") {
        expect(args[2]).toMatch(/^node -e /);
        return base.command(process.execPath, ["-e", JSON.parse(args[2]!.slice(8))], { cwd: options.workspace, signal, timeout });
      }
      return base.command(args[0]!, args.slice(1), { cwd: options.workspace, signal, timeout });
    } };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-r9b-"))); roots.push(root);
  const transport = trustedTransport(), source = join(root, "source");
  const cloned = await transport.command("git", ["clone", "--quiet", "--branch", "fixture", bundle, source]);
  expect(cloned.code).toBe(0);
  const receipt = await prepareEvaluationWorkspace(transport, "X1", source, join(root, "baseline-workspace"), new AbortController().signal);
  const repaired = await transport.command(process.execPath, ["-e", fix], { cwd: receipt.workspace }); expect(repaired.code).toBe(0);
  const checked = await transport.command(process.execPath, [fileURLToPath(new URL("../../../eval/check.mjs", import.meta.url)), `${receipt.workspace}.receipt.json`]);
  const checks = JSON.parse(checked.stdout); expect(checks.outcome).toBe("PASS");
  const baseline = join(root, "baseline"); await mkdir(baseline);
  const store = new SessionStore({ root: baseline });
  await store.append("original", { type: "session.start", task: "Original task", cwd: source, provider: "fixture", model: "fixture" });
  await store.append("original", { type: "session.end", reason: "done" });
  await writeFile(join(baseline, "checks.json"), JSON.stringify(checks));
  await writeFile(join(baseline, "manifest.json"), JSON.stringify({ version: 1, runId: receipt.runId, task: "X1",
    evaluatorRevision: "a".repeat(40), startingRevision: pin, evidenceLane: "scripted",
    configuration: { supervisor: false, memory: false, memoryCorpusSha256: null, budgets: {},
      roles: [{ role: "main", provider: "fixture", model: "fixture" }] },
    logs: [{ path: "original.jsonl", sessionId: "original", role: "main" }], checks: "checks.json",
    coverage: { sessionLogsComplete: true, auxiliaryComplete: true, externalCostsUsd: 0, evidence: ["Actual independent E1 fixture checks."] },
    timing: { startedAt: 0, settledAt: Date.now(), includesObserverAndMaintenance: true, evidence: "Fixture completed." },
    changes: { independentlyChecked: true, unintended: [], evidence: "Actual scope checks." },
  }));
  const map = join(root, "fixtures.json");
  await writeFile(map, JSON.stringify({ version: 1, workerImage: image, checkerImage: image,
    sessions: [{ sessionId: "original", task: "X1", source, baseline: join(baseline, "manifest.json") }] }));
  return { root, transport, source, map, baseline };
}

it("bundled source is bounded, exact pinned upstream history and tree, not a substitute source", async () => {
  const bytes = await readFile(bundle); expect(bytes.length).toBe(60_073); expect(bytes.length).toBeLessThan(128 * 1024);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("a6c67990dd64419575a5192f267e93402d2457404f1c24ce422e030dd0dede11");
  const { source, transport } = await fixture();
  const revision = await transport.command("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: source });
  expect(revision.stdout.trim().split(/\r?\n/)).toEqual([pin, "37450e1347ebbad642393376ee3ef67f576d1109"]);
}, 30_000);

it("default preview uses real baseline identity/pin without provider, Docker or output writes", async () => {
  const f = await fixture(), provider = vi.fn(), transport = { ...f.transport, preflight: vi.fn() };
  const result = await evaluateSessions({ sessions: ["original"], against: "candidate", fixtures: f.map,
    output: join(f.root, "output"), profile }, { transport, provider });
  expect(result.tasks).toMatchObject([{ task: "X1", baselineOutcome: "PASS" }]);
  expect(provider).not.toHaveBeenCalled(); expect(transport.preflight).not.toHaveBeenCalled();
  await expect(readFile(join(f.root, "output", "protocol.json"))).rejects.toThrow();
}, 30_000);

it("actual core tools/checker distinguish correct and broken profiles, with counted advisory calls and immutable baseline", async () => {
  const f = await fixture(), original = await readFile(join(f.baseline, "original.jsonl"));
  for (const [label, script, outcome] of [["correct", fix, "PASS"], ["broken", broken, "FAIL"]] as const) {
    const result = await evaluateSessions({ sessions: ["original"], against: label, fixtures: f.map,
      output: join(f.root, label), profile, execute: true, batchTokens: 10_000, batchMinutes: 2 },
    { transport: f.transport, provider: async (_options, role) => fake(script, role) });
    expect(result.results).toMatchObject([{ outcome, baselineOutcome: "PASS" }]);
    const report = JSON.parse(await readFile(join(f.root, label, "01-X1", "report.json"), "utf8"));
    expect(report.main.reportedUsage).toMatchObject({ input: 20, output: 10 });
    expect(report.auxiliary.reportedUsage).toMatchObject({ input: 10, output: 5 });
    expect(JSON.parse(await readFile(join(f.root, label, "calls.json"), "utf8"))).toHaveLength(3);
  }
  expect(await readFile(join(f.baseline, "original.jsonl"))).toEqual(original);
}, 30_000);

it.each(["skills", "extension", "mcpConfig", "shell", "allow", "root"])("unsupported effective %s is rejected explicitly", key => {
  expect(() => validateEvaluationProfile({ [key]: ["x"] } as never)).toThrow(`effective field: ${key}`);
});

it("shared guard counts main and auxiliary calls; unknown/retried usage prevents further scheduling", async () => {
  for (const extra of [[], [{ type: "retry", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "fixture" }]] as ModelEvent[][]) {
    const budget = new EvaluationBudget(100, 1);
    const provider: ModelProvider = { ...fake("", "supervisor"), async *stream() {
      yield* extra;
      if (extra.length) yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: "end_turn" };
    } };
    try {
      const request = { system: "", messages: [], tools: [], maxTokens: 1 };
      for await (const _event of budget.provider(provider, "supervisor").stream(request, new AbortController().signal)) { /* consume */ }
      expect(budget.unknownCalls).toBe(1); expect(() => budget.guard()).toThrow("incomplete");
    } finally { budget.close(); }
  }
});

it.runIf(process.env.AGENTRIG_EVAL_WORKER_IMAGE !== undefined || process.env.AGENTRIG_EVAL_REQUIRE_DOCKER === "1")(
  "real Linux containers distinguish correct/broken outcomes without provider credentials or network access", async () => {
    expect(process.platform).toBe("linux");
    const workerImage = process.env.AGENTRIG_EVAL_WORKER_IMAGE, checkerImage = process.env.AGENTRIG_EVAL_CHECKER_IMAGE;
    expect(workerImage).toMatch(/^sha256:[a-f0-9]{64}$/); expect(checkerImage).toMatch(/^sha256:[a-f0-9]{64}$/);
    const f = await fixture(), map = JSON.parse(await readFile(f.map, "utf8"));
    await writeFile(f.map, JSON.stringify({ ...map, workerImage, checkerImage }));
    for (const [label, script, outcome] of [["container-correct", fix, "PASS"], ["container-broken", broken, "FAIL"]] as const) {
      const result = await evaluateSessions({ sessions: ["original"], against: label, fixtures: f.map,
        output: join(f.root, label), profile, execute: true, batchTokens: 10_000, batchMinutes: 2 },
      { provider: async (_options, role) => fake(script, role) });
      expect(result.results).toMatchObject([{ outcome }]);
      const processReceipt = JSON.parse(await readFile(join(f.root, label, "01-X1", "checker-process.json"), "utf8"));
      expect(processReceipt.containerName).toMatch(/^agentrig-e3-/);
      expect(processReceipt.infrastructure).toBe(false);
    }
  }, 60_000);

it("refuses missing caps, occupied outputs, source pin mismatch and baseline identity mismatch before provider calls", async () => {
  const f = await fixture(), provider = vi.fn();
  const options = { sessions: ["original"], against: "candidate", fixtures: f.map,
    output: join(f.root, "occupied"), profile, execute: true as const };
  await expect(evaluateSessions(options, { transport: f.transport, provider })).rejects.toThrow("explicit");
  await mkdir(options.output); await writeFile(join(options.output, "keep"), "preserve");
  await expect(evaluateSessions({ ...options, batchTokens: 100, batchMinutes: 1 }, { transport: f.transport, provider })).rejects.toThrow();
  expect(await readFile(join(options.output, "keep"), "utf8")).toBe("preserve");
  const map = JSON.parse(await readFile(f.map, "utf8"));
  await writeFile(f.map, JSON.stringify({ ...map, sessions: [{ ...map.sessions[0], sessionId: "other" }] }));
  await expect(evaluateSessions({ ...options, execute: false }, { transport: f.transport, provider })).rejects.toThrow("identity");
  await writeFile(f.map, JSON.stringify(map));
  const transport: EvaluationTransport = { ...f.transport, task: async id => ({ ...await f.transport.task(id), revision: "0".repeat(40) }) };
  await expect(evaluateSessions({ ...options, execute: false }, { transport, provider })).rejects.toThrow("pinned");
  expect(provider).not.toHaveBeenCalled();
}, 30_000);

it("explicit CLI preview resolves its real named profile without constructing a provider", async () => {
  const f = await fixture(), home = join(f.root, "home"); await mkdir(join(home, ".agentrig"), { recursive: true });
  await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ profiles: { candidate: profile } }));
  const provider = vi.fn(), output = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = buildProgram({ config: { cwd: f.source, home, env: {}, interactive: false }, evaluation: { transport: f.transport, provider } });
  await program.parseAsync(["eval", "original", "--against", "candidate", "--fixtures", f.map, "--output", join(f.root, "preview")], { from: "user" });
  expect(JSON.parse(String(output.mock.calls.at(-1)![0])).tasks).toMatchObject([{ task: "X1" }]);
  expect(provider).not.toHaveBeenCalled();
}, 30_000);

it("a pre-aborted execution and unavailable Docker refuse before provider construction", async () => {
  const f = await fixture(), provider = vi.fn(), controller = new AbortController(); controller.abort();
  const options = { sessions: ["original"], against: "candidate", fixtures: f.map,
    output: join(f.root, "cancelled"), profile, execute: true as const, batchTokens: 100, batchMinutes: 1 };
  await expect(evaluateSessions({ ...options, signal: controller.signal }, { transport: f.transport, provider })).rejects.toThrow("cancelled");
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await expect(evaluationTransport().preflight([image])).rejects.toThrow(/Docker|Linux/);
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
  expect(provider).not.toHaveBeenCalled();
}, 30_000);

it("offline A preparation uses only fixed dependency directories, records image identity, and refuses failed build/tree check", async () => {
  const f = await fixture();
  for (const code of [0, 1]) {
    const directory = join(f.root, `prep-${code}`); await mkdir(directory);
    const worker = vi.fn(async (_options, args) => {
      expect(args[2]).toContain("/opt/agentrig-eval-deps/node_modules");
      expect(args[2]).toContain("pnpm build"); expect(args[2]).toContain("git diff --cached --exit-code");
      expect(args[2]).not.toContain("install");
      return { code, infrastructure: false, stdout: "fixture", stderr: "", error: null };
    });
    const pending = prepareEvaluationDependencies({ ...f.transport, worker }, { version: 1, id: "A1", runId: randomUUID(),
      workspace: f.source, repository: "fixture", revision: "a".repeat(40), baseline: "b".repeat(40), receiptPath: "unused" }, image, directory, new AbortController().signal);
    if (code === 0) await pending; else await expect(pending).rejects.toThrow("BLOCKED");
    expect(JSON.parse(await readFile(join(directory, "dependency-preparation.json"), "utf8"))).toMatchObject({ image, code, network: false });
  }
}, 30_000);

it("frozen memory is bounded, digest checked, copied without changing its input and rejects mismatches", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-r9b-memory-"))); roots.push(root);
  const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "page.md"), "safe memory");
  const bytes = Buffer.from("safe memory");
  const digest = createHash("sha256").update(`7:page.md:${bytes.length}:`).update(bytes).digest("hex");
  await evaluationMemory(source, digest, join(root, "snapshot"));
  expect(await readFile(join(root, "snapshot", "page.md"), "utf8")).toBe("safe memory");
  await expect(evaluationMemory(source, "0".repeat(64))).rejects.toThrow("digest");
  await writeFile(join(source, "huge.md"), "x".repeat(1024 * 1024 + 1));
  await expect(evaluationMemory(source, digest)).rejects.toThrow("bounded");
});
