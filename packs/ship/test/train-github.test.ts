import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TrainCommand } from "@agentkitai/agentrig-core";

import { trainPaths } from "../../../test/train-paths.ts";
import { trainGithubCommand as shipCommand } from "@agentkitai/agentrig-ship/train-github";
import { trainGithubCommand as cliCommand } from "../../../packages/cli/src/train-github.js";
describe.each(trainPaths)("$name GitHub policy", ({ name, runTrain }) => {
const trainGithubCommand = name === "core compatibility" ? cliCommand : shipCommand;
it("does not multiply rate-limit budgets through compatibility decoration", () => {
  const command: TrainCommand = async () => ({ code: 0, stdout: "", stderr: "" });
  const once = trainGithubCommand(command);
  expect(shipCommand(once)).toBe(once);
  expect(cliCommand(once)).toBe(once);
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
const row = { task: "Ship fixture", authorization: "I authorize this fixture task and its merge", scope: ["src"], environment: { checkout: resolve(tmpdir(), "fixture-checkout"), repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } };
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "train-")); roots.push(root);
  await mkdir(join(root, "queue"));
  for (let n = 1; n <= count; n++) await writeFile(join(root, "queue", `${n}.json`), JSON.stringify(row));
  const calls: string[] = [];
  let marker = "";
  const command: TrainCommand = async (request) => {
    calls.push(request.argv.join(" "));
    const a = request.argv;
    let stdout = "";
    if (a.includes("--show-toplevel")) stdout = row.environment.checkout;
    if (a[0] === "rev-parse" && !a.includes("--show-toplevel")) stdout = "c".repeat(40);
    if (a[0] === "merge-base" && a[3] === "c".repeat(40)) return { code: 1, stdout: "", stderr: "" };
    if (a.includes("--show-current")) stdout = "main";
    if (a[0] === "remote") stdout = "https://github.com/owner/repo.git";
    if (a[0] === "run" && a[1] !== "list") {
      marker = a.at(-1)?.match(/agentrig-train-row:[a-f0-9-]+/u)?.[0] ?? "";
      await writeFile(request.resultPath!, JSON.stringify({ pr: 42 }));
      request.onSession?.("fixture-session");
    }
    if (a[0] === "pr") stdout = JSON.stringify({ number: 42, body: marker, state: "MERGED", baseRefName: "main", headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) } });
    if (a[0] === "run" && a[1] === "list") stdout = JSON.stringify([{ workflowName: "CI", event: "push", headBranch: "main", headSha: "b".repeat(40), status: "completed", conclusion: "success" }]);
    return { code: 0, stdout, stderr: "" };
  };
  return { root, command, calls };
}


for (const phase of ["pr", "run"]) it(`RL1 retries fake gh ${phase} once then completes row`, async () => {
  const f = await fixture(); let failures = 0;
  const sleep = vi.fn(async () => undefined);
  const command = trainGithubCommand(async request => {
    if (request.executable === "gh" && request.argv[0] === phase && failures++ === 0)
      return { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded\nRetry-After: 1" };
    return f.command(request);
  }, { sleep });
  expect(await runTrain(f.root, { command })).toBe("empty");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
  expect(await readdir(join(f.root, "done"))).toEqual(["1.json"]);
});
it("RL2 exhausted secondary limit names rate limit, not red CI", async () => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  const command = trainGithubCommand(async request => request.executable === "gh" && request.argv[0] === "run"
    ? { code: 1, stdout: "", stderr: "HTTP 429 secondary rate limit\nRetry-After: 2" } : f.command(request), { ceilingMs: 1000, sleep });
  expect(await runTrain(f.root, { command })).toBe("halted");
  expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8"))).toMatchObject({ phase: "ci", reason: expect.stringContaining("GitHub rate limit exhausted") });
  expect(sleep).not.toHaveBeenCalled();
});
it("RL3 actual failed CI remains a CI halt", async () => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  const command = trainGithubCommand(async request => {
    const result = await f.command(request);
    if (request.executable === "gh" && request.argv[0] === "run") result.stdout = result.stdout.replace('"success"', '"failure"');
    return result;
  }, { sleep });
  expect(await runTrain(f.root, { command })).toBe("halted");
  expect(JSON.parse(await readFile(join(f.root, "logs/1.halt.json"), "utf8")).reason).toContain("post-merge CI not green");
  expect(sleep).not.toHaveBeenCalled();
});
for (const [text, probe, expected] of [
  ["HTTP 403 rate limit exceeded\nx-ratelimit-reset: 102", "", 2000],
  ["HTTP 429\nRetry-After: Thu, 01 Jan 1970 00:01:43 GMT", "", 3000],
  ["HTTP 403 API rate limit exceeded", '{"resources":{"graphql":{"remaining":0,"reset":104}}}', 4000],
  ["HTTP 403 secondary rate limit", "bad json", 60000],
] as const) it(`RL4 uses metadata/backoff: ${expected}`, async () => {
  const f = await fixture(); let calls = 0; const sleep = vi.fn(async () => undefined);
  const command = trainGithubCommand(async request => {
    if (request.argv[0] === "api") return { code: 0, stdout: probe, stderr: "" };
    return calls++ === 0 ? { code: 1, stdout: "", stderr: text } : { code: 0, stdout: "ok", stderr: "" };
  }, { now: () => 100000, sleep });
  expect((await command({ executable: "gh", argv: ["pr", "view"], cwd: f.root, log: join(f.root, "gh.log") })).stdout).toBe("ok");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(expected);
});
it("RL5 ordinary forbidden and non-gh failures are never retried", async () => {
  const f = await fixture();
  for (const [executable, stderr] of [["gh", "HTTP 403 Resource not accessible"], ["pnpm", "rate limit exceeded"]]) {
    const underlying = vi.fn(async () => ({ code: 1, stdout: "", stderr: stderr! }));
    const command = trainGithubCommand(underlying);
    expect((await command({ executable: executable!, argv: [], cwd: f.root, log: join(f.root, "gh.log") })).code).toBe(1);
    expect(underlying).toHaveBeenCalledTimes(1);
  }
});
it("RL6 repeated short waits cannot bypass cumulative ceiling", async () => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  const underlying = vi.fn(async () => ({ code: 1, stdout: "", stderr: "HTTP 429\nRetry-After: 1" }));
  const command = trainGithubCommand(underlying, { ceilingMs: 2000, now: () => 0, sleep });
  await expect(command({ executable: "gh", argv: ["run", "list"], cwd: f.root, log: join(f.root, "gh.log") })).rejects.toThrow("rate limit exhausted");
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(underlying).toHaveBeenCalledTimes(3);
});
it("B1 bare PR number 429 preserves permanent failure without probing or waiting", async () => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  const failure = { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest with the number of 429." };
  const underlying = vi.fn(async () => failure);
  const command = trainGithubCommand(underlying, { ceilingMs: 1, sleep });
  expect(await command({ executable: "gh", argv: ["pr", "view", "429"], cwd: f.root, log: join(f.root, "gh.log") })).toEqual(failure);
  expect(underlying).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
it.each(["HTTP 429", "HTTP/2 429", "HTTP/1.1 429", "HTTP 403: API rate limit exceeded", "HTTP 403: secondary rate limit"])('B1 retains explicit status and rate-limit diagnostics: %s', async stderr => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  const underlying = vi.fn().mockResolvedValueOnce({ code: 1, stdout: "", stderr: `${stderr}\nRetry-After: 1` }).mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
  const command = trainGithubCommand(underlying, { sleep });
  expect((await command({ executable: "gh", argv: ["pr", "view"], cwd: f.root, log: join(f.root, "gh.log") })).stdout).toBe("ok");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
  expect(underlying).toHaveBeenCalledTimes(2);
});
for (const phase of ["pr", "run"]) for (const unrelatedReset of [101, 3400]) it(`B2 ${phase} recovers using its own resource, unrelated reset ${unrelatedReset}`, async () => {
  const f = await fixture(); const sleep = vi.fn(async () => undefined);
  let elapsed = 0; let probes = 0; let attempts = 0;
  sleep.mockImplementation(async ms => { elapsed += ms; });
  const resource = phase === "pr" ? "graphql" : "core";
  const other = phase === "pr" ? "core" : "graphql";
  const command = trainGithubCommand(async request => {
    if (request.executable === "gh" && request.argv[0] === "api") {
      probes++;
      return { code: 0, stderr: "", stdout: JSON.stringify({ resources: {
        [resource]: { remaining: 0, reset: 130 },
        [other]: { remaining: 0, reset: unrelatedReset },
        search: { remaining: 0, reset: unrelatedReset },
      } }) };
    }
    if (request.executable === "gh" && request.argv[0] === phase) {
      attempts++;
      if (elapsed < 30000) return { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" };
    }
    return f.command(request);
  }, { now: () => 100000 + elapsed, sleep });
  expect(await runTrain(f.root, { command })).toBe("empty");
  expect(await readdir(join(f.root, "done"))).toEqual(["1.json"]);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(30000);
  expect(probes).toBe(1);
  expect(attempts).toBe(2);
});

});
