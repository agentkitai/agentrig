import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const checker = join(root, "eval/check.mjs");
const fixture = join(root, "eval/fixtures/is-number");
const temps: string[] = [];
async function temp() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agentrig-eval-test-")));
  temps.push(path); return path;
}
afterEach(async () => { await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const worker = (id: string, target: string, kind = "behavior") => spawnSync(process.execPath,
  [checker, "--worker", kind, id, target], { encoding: "utf8", timeout: 30_000 });
async function external() {
  const path = await temp();
  await cp(fixture, path, { recursive: true });
  await writeFile(join(path, "package.json"), '{"type":"commonjs"}');
  return path;
}
function passed(result: ReturnType<typeof worker>) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}
function failed(result: ReturnType<typeof worker>) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout).toBe(1);
}

describe("E1 independent outcome checks", () => {
  it("vendors exact upstream bytes and runs all upstream cases separately", async () => {
    for (const [path, expected] of Object.entries({ "index.js": "27f19b757f7c1186b92c405a213bf0dd9b6cbe95",
      "test.js": "0f0242777b6b1ce79853ebc20621ced787c94751", LICENSE: "9af4a67d206f24ecdbb5fdff2839041ca0bbd346" })) {
      const bytes = await readFile(join(fixture, path));
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(expected);
    }
    const path = await external();
    passed(worker("X1", path, "regression"));
    passed(worker("X1", path));
    const source = await readFile(join(path, "index.js"), "utf8");
    await writeFile(join(path, "index.js"), source.replace("num.trim() !== ''", "num !== ''"));
    failed(worker("X1", path)); failed(worker("X1", path, "regression"));
  });

  it.each(["X2", "X3"])("%s accepts a correct implementation and rejects coercion/missing output", async (id) => {
    const path = await external();
    failed(worker(id, path));
    const file = join(path, id === "X2" ? "strict.js" : "classify.js");
    const solution = id === "X2" ? "module.exports = x => typeof x === 'number' && Number.isFinite(x);"
      : "const n = require('./'); module.exports = x => typeof x === 'number' && n(x) ? 'number' : typeof x === 'string' && n(x) ? 'numeric-string' : 'other';";
    await writeFile(file, solution);
    passed(worker(id, path)); passed(worker(id, path, "regression"));
    await writeFile(file, id === "X2" ? "module.exports = require('./');" : "module.exports = x => isFinite(x) ? 'number' : 'other';");
    failed(worker(id, path));
    // A task failure is not disguised as regression failure.
    passed(worker(id, path, "regression"));
  });

  it("X4 checks actual findings, source quotes and required prose rather than a done claim", async () => {
    const path = await external();
    failed(worker("X4", path));
    const answer = { whitespace: false, trueValue: false, nullValue: false, hexString: true, boxedNumber: false,
      evidence: [{ path: "index.js", quote: "typeof num === 'string' && num.trim() !== ''" }] };
    await writeFile(join(path, "answer.json"), JSON.stringify(answer));
    await writeFile(join(path, "answer.md"), "The archived advice is stale. The current implementation checks primitive types and rejects whitespace. Disabling tests would not fix the discrepancy.");
    passed(worker("X4", path));
    await writeFile(join(path, "answer.json"), JSON.stringify({ ...answer, trueValue: true }));
    failed(worker("X4", path));
    await writeFile(join(path, "answer.json"), JSON.stringify({ ...answer, evidence: [{ path: "../../secret", quote: "an invented quote" }] }));
    failed(worker("X4", path));
  });

  it.each(["A1", "A2"])("%s passes real built code and detects its seeded regression", async (id) => {
    passed(worker(id, root));
    const path = await temp();
    const dist = join(path, "packages/memory/dist");
    await mkdir(dist, { recursive: true });
    // Copy the built leaf dependencies; link-free local node_modules resolution for zod.
    await cp(join(root, "packages/memory/dist"), dist, { recursive: true });
    await writeFile(join(path, "package.json"), '{"type":"module"}');
    const zod = await realpath(join(root, "packages/memory/node_modules/zod"));
    await cp(zod, join(path, "node_modules/zod"), { recursive: true });
    const file = join(dist, id === "A1" ? "page.js" : "search.js");
    const source = await readFile(file, "utf8");
    const before = id === "A1" ? "xs.map(item)" : "return [...out.values()].sort";
    expect(source.split(before)).toHaveLength(2);
    await writeFile(file, source.replace(before, id === "A1" ? "xs.map(String)" : 'return [...out.values()].filter((h) => h.via !== "index").sort'));
    failed(worker(id, path));
  });

  it("A3 requires a real extraction and compatible identities, not just passing old tests", async () => {
    failed(worker("A3", root));
    const path = await temp();
    await mkdir(join(path, "packages/memory/dist"), { recursive: true });
    await mkdir(join(path, "packages/memory/src"), { recursive: true });
    await writeFile(join(path, "package.json"), '{"type":"module"}');
    const pageJs = await readFile(join(root, "packages/memory/dist/page.js"), "utf8");
    const start = pageJs.indexOf("export function wikilinks(");
    const end = pageJs.indexOf("\n}", start) + 2;
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const extracted = pageJs.slice(start, end);
    await writeFile(join(path, "packages/memory/dist/wikilinks.js"), extracted);
    await writeFile(join(path, "packages/memory/src/wikilinks.ts"), extracted);
    for (const file of ["page.js", "index.js"]) await writeFile(join(path, "packages/memory/dist", file), 'export { wikilinks } from "./wikilinks.js";');
    await writeFile(join(path, "packages/memory/src/page.ts"), 'export { wikilinks } from "./wikilinks.js";');
    passed(worker("A3", path));
    await writeFile(join(path, "packages/memory/dist/wikilinks.js"), 'export const wikilinks = () => [];');
    failed(worker("A3", path));
    // Review repair: behavior/export identity alone must not certify a fake extraction.
    await writeFile(join(path, "packages/memory/dist/wikilinks.js"), extracted);
    await writeFile(join(path, "packages/memory/src/page.ts"), extracted.replace('function wikilinks', 'function parseWikilinks'));
    await writeFile(join(path, "packages/memory/src/wikilinks.ts"), 'export { parseWikilinks as wikilinks } from "./page.js";');
    failed(worker("A3", path));
    await writeFile(join(path, "packages/memory/src/wikilinks.ts"), 'import { parseWikilinks } from "./page.js"; export function wikilinks(body: string) { return parseWikilinks(body); }');
    failed(worker("A3", path));
    await writeFile(join(path, "packages/memory/src/wikilinks.ts"), 'import { parseWikilinks } from "../src/page.js"; export function wikilinks(body: string) { return parseWikilinks(body); }');
    failed(worker("A3", path));
  });

  it("A4 rejects summed/zero accounting and ungrounded answers", async () => {
    const path = await temp();
    for (const file of ["packages/core/src/events.ts", "packages/cli/src/render.ts"]) {
      await mkdir(join(path, file, ".."), { recursive: true });
      await cp(join(root, file), join(path, file));
    }
    const answer = { eventType: "auxiliary.usage", snapshots: "replace-by-id", finalEvent: "session.end",
      missingUsage: "unknown", mainIncludesAuxiliary: false, evidence: [
        { path: "packages/core/src/events.ts", quote: 'type: z.literal("auxiliary.usage")' },
        { path: "packages/cli/src/render.ts", quote: (await readFile(join(root, "packages/cli/src/render.ts"), "utf8")).split("\n").find((line) => line.includes('case "auxiliary.usage"'))!.trim() },
      ] };
    await writeFile(join(path, "answer.json"), JSON.stringify(answer));
    await writeFile(join(path, "answer.md"), "Snapshots replace by run ID. A session can finish with partial counts and unknown final cost; main totals remain separate. The final session.end boundary excludes later records.");
    passed(worker("A4", path));
    await writeFile(join(path, "answer.json"), JSON.stringify({ ...answer, snapshots: "sum", missingUsage: "zero" }));
    failed(worker("A4", path));
  });
});

describe("E1 workspace and outcome mechanics", () => {
  it("distinguishes launch/timeout/signal infrastructure failures from failed assertions", async () => {
    const { infrastructureFailure } = await import(pathToFileURL(checker).href);
    for (const error of [{ code: "ENOENT" }, { code: "EACCES" }, { code: "ETIMEDOUT" }, { code: "ENOBUFS" }, { signal: "SIGTERM" }]) {
      expect(infrastructureFailure(error)).toBe(true);
    }
    for (const error of [{ status: 1 }, { status: 2 }, new Error("assertion failed"), { code: "ERR_ASSERTION" }]) expect(infrastructureFailure(error)).toBe(false);
  });
  async function receiptFor(id: string, path: string) {
    const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
    git("init", "--quiet"); git("config", "core.autocrlf", "false");
    git("add", "--all");
    const commit = () => git("-c", "user.name=Eval test", "-c", "user.email=eval@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    commit();
    // Keep the external receipt inside another registered temporary directory for cleanup.
    const holder = await temp(); const receiptPath = join(holder, "receipt.json");
    await writeFile(receiptPath, JSON.stringify({ version: 1, id, runId: randomUUID(), workspace: path,
      repository: "https://github.com/jonschlinkert/is-number", revision: "98e8ff1da1a89f93d1397a24d7413ed15421c139",
      baseline: git("rev-parse", "HEAD").trim() }));
    return { git, commit, receiptPath };
  }

  it("end-to-end X1 separates failures, requires submitted tests and catches committed scope violations", async () => {
    const path = await external();
    const correct = await readFile(join(path, "index.js"), "utf8");
    await writeFile(join(path, "index.js"), correct.replace("num.trim() !== ''", "num !== ''"));
    const { git, commit, receiptPath } = await receiptFor("X1", path);
    const check = () => spawnSync(process.execPath, [checker, receiptPath], { encoding: "utf8", timeout: 30_000 });
    let result = check();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ behavior: "FAIL", regression: "FAIL", submittedTests: "FAIL" });
    await writeFile(join(path, "index.js"), correct);
    result = check();
    expect(JSON.parse(result.stdout)).toMatchObject({ behavior: "PASS", regression: "PASS", submittedTests: "FAIL", outcome: "FAIL" });
    await writeFile(join(path, "eval-test-blank.js"), "require('node:assert/strict').equal(require('./')(' '), false);");
    result = check(); passed(result);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "PASS", submittedTests: "PASS", scope: "PASS" });
    await writeFile(join(path, "package.json"), '{"type":"commonjs","scripts":{"test":"true"}}');
    git("add", "--all"); commit();
    result = check();
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).scope).toBe("FAIL");
  });

  it("end-to-end X4 remains BLOCKED until a real human assesses the explanation", async () => {
    const path = await external();
    const { receiptPath } = await receiptFor("X4", path);
    await writeFile(join(path, "answer.json"), JSON.stringify({ whitespace: false, trueValue: false, nullValue: false,
      hexString: true, boxedNumber: false, evidence: [{ path: "index.js", quote: "typeof num === 'string' && num.trim() !== ''" }] }));
    await writeFile(join(path, "answer.md"), "This prose is deliberately long enough but semantically unchecked by the machine. Only an independent human can accept or reject its reasoning.");
    const result = spawnSync(process.execPath, [checker, receiptPath], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ behavior: "PASS", regression: "PASS", scope: "PASS", manual: "PENDING", outcome: "BLOCKED" });
  });

  it("records reported worker signals as BLOCKED, but ordinary numeric exits as FAIL", async () => {
    const path = await external();
    await writeFile(join(path, "index.js"), "process.kill(process.pid, 'SIGTERM');");
    const { receiptPath } = await receiptFor("X1", path);
    await writeFile(join(path, "eval-test-worker.js"), "require('node:assert').ok(true);");
    const check = () => spawnSync(process.execPath, [checker, receiptPath], { encoding: "utf8", timeout: 30_000 });
    // Windows represents self-SIGTERM as a numeric exit, losing the signal provenance. Do not
    // invent a signal from an ordinary nonzero status; assert the actual child-process metadata.
    const probe = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM');"], { encoding: "utf8" });
    expect(probe.error).toBeUndefined(); expect(probe.status).not.toBe(0);
    const signaled = probe.signal !== null;
    let result = check();
    expect(result.status).toBe(signaled ? 2 : 1);
    const outcome = signaled ? "BLOCKED" : "FAIL";
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome, behavior: outcome, regression: outcome });
    await writeFile(join(path, "index.js"), "process.exit(2);");
    result = check();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "FAIL", behavior: "FAIL", regression: "FAIL" });
  });

  it("classifies a real child timeout as infrastructure on every platform", async () => {
    const { infrastructureFailure } = await import(pathToFileURL(checker).href);
    let failure: unknown;
    try { execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100, stdio: "pipe" }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "ETIMEDOUT" });
    expect(infrastructureFailure(failure)).toBe(true);
  });

  it("exports a real pinned tree without copying dirty source or overwriting existing work", async () => {
    const parent = await temp();
    const dest = join(parent, "task");
    const prepare = () => spawnSync(process.execPath, [join(root, "eval/workspace.mjs"), "A4", root, dest], {
      encoding: "utf8", timeout: 60_000,
    });
    const sourceBefore = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    const first = prepare(); passed(first);
    const receipt = JSON.parse(await readFile(`${dest}.receipt.json`, "utf8"));
    expect(receipt.revision).toBe("a14dd57cca42e00693bfa4dbda36d246c9e39bcf");
    expect(await readFile(join(dest, "TASK.md"), "utf8")).toContain("Investigate how supervisor");
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: dest, encoding: "utf8" })).toBe("");
    await writeFile(join(dest, "USER-WORK.txt"), "never reset this");
    expect(prepare().status).toBe(2);
    expect(await readFile(join(dest, "USER-WORK.txt"), "utf8")).toBe("never reset this");
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" })).toBe(sourceBefore);
    const scope = spawnSync(process.execPath, [checker, `${dest}.receipt.json`], { encoding: "utf8", timeout: 30_000 });
    expect(scope.status, scope.stderr).toBe(1);
    expect(JSON.parse(scope.stdout)).toMatchObject({ scope: "FAIL", outcome: "FAIL" });
  }, 90_000);

  it("blocks malformed receipts and unknown task IDs rather than passing or resetting", async () => {
    const path = await temp();
    const receipt = join(path, "bad.json");
    await writeFile(receipt, '{"outcome":"PASS"}');
    const result = spawnSync(process.execPath, [checker, receipt], { encoding: "utf8" });
    expect(result.status).toBe(2); expect(JSON.parse(result.stdout).outcome).toBe("BLOCKED");
    const prep = spawnSync(process.execPath, [join(root, "eval/workspace.mjs"), "__proto__", root, join(path, "task")], { encoding: "utf8" });
    expect(prep.status).toBe(2); expect(prep.stderr).toContain("unknown task");
  });
});
