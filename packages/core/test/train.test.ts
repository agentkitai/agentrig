import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runTrain, trainCommand, TrainRowSchema, type TrainCommand } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
const row = { task: "Ship fixture", authorization: "I authorize this fixture task and its merge", scope: ["src"], environment: { checkout: resolve(tmpdir(), "fixture-checkout"), repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } };
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "train-")); roots.push(root);
  await mkdir(join(root, "queue"));
  for (let n = 1; n <= count; n++) await writeFile(join(root, "queue", `${n}.json`), JSON.stringify(row));
  const calls: string[] = [];
  const command: TrainCommand = async (request) => {
    calls.push(request.argv.join(" "));
    const a = request.argv;
    let stdout = "";
    if (a.includes("--show-toplevel")) stdout = row.environment.checkout;
    if (a.includes("--show-current")) stdout = "main";
    if (a[0] === "remote") stdout = "https://github.com/owner/repo.git";
    if (a[0] === "run" && a[1] !== "list") {
      await writeFile(request.resultPath!, JSON.stringify({ pr: 42 }));
      request.onSession?.("fixture-session");
    }
    if (a[0] === "pr") stdout = JSON.stringify({ number: 42, state: "MERGED", baseRefName: "main", headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) } });
    if (a[0] === "run" && a[1] === "list") stdout = JSON.stringify([{ workflowName: "CI", event: "push", headBranch: "main", headSha: "b".repeat(40), status: "completed", conclusion: "success" }]);
    return { code: 0, stdout, stderr: "" };
  };
  return { root, command, calls };
}
describe("train", () => {
  it("refuses invalid schema before running any command", async () => {
    const f = await fixture(); await writeFile(join(f.root, "queue/1.json"), "{}");
    expect(TrainRowSchema.safeParse({ ...row, environment: { ...row.environment, yolo: "yes" } }).success).toBe(false);
    expect(await runTrain(f.root, { command: f.command })).toBe("halted");
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8"))).toMatchObject({ phase: "schema", pr: null, sessionIds: [] });
  });
  it("validates checkout between every row and prints each status", async () => {
    const f = await fixture(2); const statuses: unknown[] = [];
    expect(await runTrain(f.root, { command: f.command, status: value => statuses.push(value) })).toBe("empty");
    expect(await readdir(join(f.root, "done"))).toEqual(["1.json", "2.json"]);
    expect(f.calls.filter(c => c === "fetch origin main")).toHaveLength(2);
    expect(f.calls.filter(c => c === "install --frozen-lockfile")).toHaveLength(2);
    for (const check of ["build", "typecheck", "test"]) expect(f.calls.filter(c => c === check)).toHaveLength(2);
    expect(statuses).toHaveLength(2);
    const runs = f.calls.map((c, i) => c.startsWith("run --headless") ? i : -1).filter(i => i >= 0);
    expect(f.calls.slice(runs[0]! + 1, runs[1])).toContain("fetch origin main");
  });
  for (const mode of ["unmerged", "red", "wrong-sha", "empty-ci", "wrong-branch"] as const) it(`never marks done for ${mode}`, async () => {
    const f = await fixture();
    const command: TrainCommand = async request => {
      const result = await f.command(request);
      if (request.argv[0] === "pr" && mode === "unmerged") result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), state: "OPEN" });
      if (request.argv[1] === "list") {
        const runs = JSON.parse(result.stdout);
        if (mode === "red") runs[0].conclusion = "failure";
        if (mode === "wrong-sha") runs[0].headSha = "c".repeat(40);
        if (mode === "wrong-branch") runs[0].headBranch = "other";
        result.stdout = JSON.stringify(mode === "empty-ci" ? [] : runs);
      }
      return result;
    };
    expect(await runTrain(f.root, { command })).toBe("halted");
    expect(await readdir(join(f.root, "done"))).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8"))).toMatchObject({ pr: 42, sessionIds: ["fixture-session"], phase: mode === "unmerged" ? "landing" : "ci" });
  });
  it("halts a dirty second checkout without executing the next row", async () => {
    const f = await fixture(2); let checks = 0;
    const command: TrainCommand = async request => {
      const result = await f.command(request);
      if (request.argv[0] === "status" && ++checks === 2) result.stdout = " M dirty";
      return result;
    };
    expect(await runTrain(f.root, { command })).toBe("halted");
    expect(await readdir(join(f.root, "done"))).toEqual(["1.json"]);
    expect(f.calls.filter(c => c.startsWith("run --headless"))).toHaveLength(1);
  });
  it("retries a classified infrastructure failure once, never a test failure", async () => {
    for (const infra of [true, false]) {
      const f = await fixture(); let attempts = 0;
      const command: TrainCommand = async request => request.argv[0] === "test" && ++attempts === 1
        ? { code: 1, stdout: "", stderr: infra ? "ECONNRESET" : "AssertionError" } : f.command(request);
      expect(await runTrain(f.root, { command })).toBe(infra ? "empty" : "halted");
      expect(attempts).toBe(infra ? 2 : 1);
    }
  });
  it("STOP wins over PAUSE, leaves pending rows untouched", async () => {
    const f = await fixture(); await writeFile(join(f.root, "STOP"), ""); await writeFile(join(f.root, "PAUSE"), "");
    expect(await runTrain(f.root, { command: f.command })).toBe("stopped"); expect(f.calls).toEqual([]);
    expect(await readdir(join(f.root, "queue"))).toEqual(["1.json"]);
  });
  it("PAUSE waits until removed, then drains; STOP after a row prevents the next", async () => {
    const f = await fixture(2); let sleeps = 0;
    await writeFile(join(f.root, "PAUSE"), "");
    expect(await runTrain(f.root, { command: async request => {
      const result = await f.command(request);
      if (request.argv[1] === "list") await writeFile(join(f.root, "STOP"), "");
      return result;
    }, sleep: async () => { sleeps++; expect(f.calls).toEqual([]); await rm(join(f.root, "PAUSE")); } })).toBe("stopped");
    expect(sleeps).toBe(1); expect(await readdir(join(f.root, "done"))).toEqual(["1.json"]);
    expect(await readdir(join(f.root, "queue"))).toEqual(["2.json"]);
  });
  it("never retries exhausted infrastructure, row execution, or a non-merged result", async () => {
    const f = await fixture(); let attempts = 0;
    const command: TrainCommand = async request => request.argv[0] === "fetch"
      ? (++attempts, { code: 1, stdout: "", stderr: "ECONNRESET" }) : f.command(request);
    expect(await runTrain(f.root, { command })).toBe("halted"); expect(attempts).toBe(2);
    expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8"))).toMatchObject({ phase: "checkout" });
  });
  it("persists a failing child's session and PR in the halt record", async () => {
    const f = await fixture(); let attempts = 0;
    const command: TrainCommand = async request => {
      const result = await f.command(request);
      if (request.resultPath !== undefined) { attempts++; result.code = 1; }
      return result;
    };
    expect(await runTrain(f.root, { command })).toBe("halted"); expect(attempts).toBe(1);
    expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8"))).toMatchObject({ phase: "run", pr: 42, sessionIds: ["fixture-session"] });
  });
  it("recovers an interrupted active row without executing it", async () => {
    const f = await fixture(); await mkdir(join(f.root, "active"));
    await writeFile(join(f.root, "active/interrupted.json"), JSON.stringify(row));
    expect(await runTrain(f.root, { command: f.command })).toBe("halted"); expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, "logs/interrupted.halt.json"), "utf8"))).toMatchObject({ phase: "recovery", pr: null, head: null, sessionIds: [] });
  });
  it("passes resume in the existing run path with no trust or permission bypass", async () => {
    const f = await fixture(); await writeFile(join(f.root, "queue/1.json"), JSON.stringify({ ...row, resume: { session: "previous", pr: 42 } }));
    expect(await runTrain(f.root, { command: f.command })).toBe("empty");
    const run = f.calls.find(c => c.startsWith("run --headless"))!;
    expect(run).toContain("--resume previous"); expect(run).toContain(join(f.root, "logs", "sessions"));
    expect(run).not.toContain("--yolo"); expect(run).not.toContain("--trust");
  });

  it("preserves the authorization quote exactly and refuses blank authorization", () => {
    const authorization = "  Human quote\n";
    expect(TrainRowSchema.parse({ ...row, authorization }).authorization).toBe(authorization);
    expect(TrainRowSchema.safeParse({ ...row, authorization: "  " }).success).toBe(false);
  });
  it("real argv adapter logs output and observes session events without a shell", async () => {
    const f = await fixture(); const sessions: string[] = [];
    const result = await trainCommand({ executable: process.execPath,
      argv: ["-e", 'console.log(JSON.stringify({sessionId:"real-fixture"})); console.error("stderr-fixture"); console.log(process.argv[1]);', "; not a shell command"],
      cwd: f.root, log: join(f.root, "adapter.log"), onSession: id => sessions.push(id) });
    expect(result.code).toBe(0); expect(sessions).toEqual(["real-fixture"]);
    expect(result.stdout).toContain("; not a shell command"); expect(result.stderr).toContain("stderr-fixture");
    expect(await readFile(join(f.root, "adapter.log"), "utf8")).toContain("real-fixture");
  });

});
