import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulePolicy, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { reviewChanges, renderReview, reviewArguments, reviewFailure, type ReviewOptions } from "../src/review.js";
import { reviewProcess, type ReviewProcess } from "../src/review-process.js";
import { buildProgram } from "../src/program.js";
import { TuiController } from "../src/tui/controller.js";
import { parseCommand, RESERVED_COMMAND_NAMES } from "../src/tui/commands.js";

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const defaults: ReviewOptions = { provider: "fixture", model: "fixture" };
const signal = () => new AbortController().signal;
const answer = { summary: "Advisory observation.", findings: [{ path: "a.ts", side: "new", line: 1, severity: "medium", message: "Returning2 changes the result." }] };
const patch = "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;\n";
function fake(onCall?: () => Promise<void>, complete = true, text = JSON.stringify(answer)) {
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 32_768 },
    async *stream(request) { calls.push(request); await onCall?.(); yield { type: "text_delta", text }; if (complete) yield { type: "usage", usage: { input: 20, output: 10 } }; yield { type: "stop", reason: "end_turn" }; } };
  return { provider, calls };
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "agentrig-review-")); roots.push(root);
  const git = (args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.autocrlf=false", ...args], { cwd: root });
  await git(["init", "-q"]); await writeFile(join(root, "a.ts"), "return 1;\n"); await git(["add", "a.ts"]); await git(["commit", "-qm", "fixture"]);
  return { root, git };
}
describe("R15e actual diff review", () => {
  it("actual CLI uses the local OpenAI adapter, no main or unrelated role construction", async () => {
    const { root } = await repo(); await writeFile(join(root, "a.ts"), "return 2;\n"); const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      let text = ""; for await (const chunk of request) text += chunk;
      requests.push(JSON.parse(text)); response.setHeader("content-type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const original = process.cwd();
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
      process.chdir(root); vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-real-key");
      const output = vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
      await buildProgram({ config: { cwd: root, home: root, env: {} } }).parseAsync(["review", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`], { from: "user" });
      expect(requests).toHaveLength(1); expect(JSON.stringify(requests[0])).toContain("untrusted");
      expect(output.mock.calls.flat().join("\n")).toContain("a.ts:1 (new, medium)"); expect(process.exitCode ?? 0).toBe(0);
    } finally { process.chdir(original); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("reviews actual tracked Git text, excludes untracked files and leaves repo untouched", async () => {
    const { root, git } = await repo(); await writeFile(join(root, "a.ts"), "return 2;\n"); await writeFile(join(root, "untracked.secret"), "untracked-canary");
    await git(["config", "branch.feature/review.remote", "origin"]);
    const before = await git(["status", "--porcelain"]); const model = fake();
    const result = await reviewChanges(root, defaults, signal(), { provider: () => model.provider });
    expect(renderReview(result).join("\n")).toContain("a.ts:1 (new, medium)"); expect(result.identity).toContain("sha256:");
    expect(result.coverage).toContain("untracked files excluded"); expect(JSON.stringify(model.calls)).not.toContain("untracked-canary");
    expect((await git(["status", "--porcelain"])).stdout).toBe(before.stdout); expect(await readFile(join(root, "a.ts"), "utf8")).toBe("return 2;\n");
    expect(result.usage?.calls).toHaveLength(1);
  });
  it("pins base commits and refuses observed worktree/HEAD changes after a model call", async () => {
    const { root, git } = await repo(); const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(root, "a.ts"), "return 2;\n"); await git(["commit", "-qam", "change"]);
    const model = fake(); expect((await reviewChanges(root, { ...defaults, base }, signal(), { provider: () => model.provider })).review.findings).toHaveLength(1);
    await writeFile(join(root, "a.ts"), "return 3;\n"); const changing = fake(() => writeFile(join(root, "a.ts"), "return 4;\n"));
    await expect(reviewChanges(root, defaults, signal(), { provider: () => changing.provider })).rejects.toThrow("state changed");
  });
  it("refuses nested cwd rather than declaring a scoped read while capturing parent files", async () => {
    const { root } = await repo(); const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "nested")); await writeFile(join(root, "a.ts"), "return 2;\n"); const factory = vi.fn(() => fake().provider);
    await expect(reviewChanges(join(root, "nested"), defaults, signal(), { provider: factory })).rejects.toThrow("repository root");
    expect(factory).not.toHaveBeenCalled();
  });
  it("refuses actual added and deleted gitlinks before any provider call", async () => {
    const { root, git } = await repo(); const base = (await git(["rev-parse", "HEAD"])).stdout.trim(); const factory = vi.fn(() => fake().provider);
    await git(["update-index", "--add", "--cacheinfo", `160000,${base},sub`]); await git(["commit", "-qm", "gitlink added"]);
    await expect(reviewChanges(root, { ...defaults, base }, signal(), { provider: factory })).rejects.toThrow("submodule");
    const added = (await git(["rev-parse", "HEAD"])).stdout.trim(); await git(["update-index", "--force-remove", "sub"]); await git(["commit", "-qm", "gitlink deleted"]);
    await expect(reviewChanges(root, { ...defaults, base: added }, signal(), { provider: factory })).rejects.toThrow("submodule");
    expect(factory).not.toHaveBeenCalled();
  });
  it("refuses sandbox, invalid args, binary/oversized patches and denied reads before provider construction", async () => {
    const { root } = await repo(); const factory = vi.fn(() => fake().provider);
    expect((await reviewChanges(root, defaults, signal(), { provider: factory })).review.findings).toEqual([]); expect(factory).not.toHaveBeenCalled();
    for (const opts of [{ sandbox: "read-only", yolo: true }, { pr: "-1" }, { base: "--help" }, { comment: true }, { base: "HEAD", pr: "1" }, { deny: ["read"] }])
      await expect(reviewChanges(root, { ...defaults, ...opts }, signal(), { provider: factory })).rejects.toThrow();
    await writeFile(join(root, "a.ts"), "x".repeat(17_000)); await expect(reviewChanges(root, defaults, signal(), { provider: factory })).rejects.toThrow();
    await writeFile(join(root, "a.ts"), Buffer.from([0, 1, 2])); await expect(reviewChanges(root, defaults, signal(), { provider: factory })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("disables repository-controlled external diff/textconv and rejects pre-cancelled work", async () => {
    const { root, git } = await repo(); await writeFile(join(root, "a.ts"), "return 2;\n");
    const canary = join(root, "hook-executed"); const script = join(root, "hook.cjs");
    await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(canary)},'executed');process.stdin.pipe(process.stdout);`);
    await git(["config", "core.fsmonitor", `node ${JSON.stringify(script)}`]);
    await git(["config", "diff.external", "definitely-not-an-executable-review-canary"]);
    await git(["config", "diff.fixture.textconv", "definitely-not-an-executable-review-canary"]);
    await writeFile(join(root, ".gitattributes"), "a.ts diff=fixture\n");
    const model = fake(); expect((await reviewChanges(root, defaults, signal(), { provider: () => model.provider })).review.findings).toHaveLength(1);
    await expect(readFile(canary)).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort(); const factory = vi.fn(() => model.provider);
    await expect(reviewChanges(root, defaults, aborted.signal, { provider: factory })).rejects.toThrow(); expect(factory).not.toHaveBeenCalled();
    await git(["config", "filter.fixture.clean", `node ${JSON.stringify(script)}`]);
    await writeFile(join(root, ".gitattributes"), "a.ts filter=fixture\n");
    await expect(reviewChanges(root, defaults, signal(), { provider: factory })).rejects.toThrow("filter configuration");
    expect(factory).not.toHaveBeenCalled();
    await expect(readFile(canary)).rejects.toThrow();
  });
  it("actual bounded Git helper refuses overflow and joins owned descendant cancellation", async () => {
    const { root } = await repo();
    await expect(reviewProcess("git", ["--version"], { cwd: root, signal: signal(), maxBytes: 1 })).rejects.toThrow("bound");
    const pidPath = join(root, "owned.pid"); const controller = new AbortController();
    const script = `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`;
    const running = reviewProcess("git", ["-c", `alias.review-owned=!node -e '${script.replaceAll("'", "'\\''")}'`, "review-owned"], { cwd: root, signal: controller.signal });
    const rejected = expect(running).rejects.toThrow("cancelled");
    await vi.waitFor(async () => expect(await readFile(pidPath, "utf8")).toMatch(/^\d+$/), { timeout: 5000 });
    const pid = Number(await readFile(pidPath, "utf8")); controller.abort(); await rejected;
    await vi.waitFor(() => { try { process.kill(pid, 0); throw new Error("owned descendant is still live"); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); } }, { timeout: 5000 });
  }, 20_000);
  it("actual CLI uses the same operation and prints bounded golden findings", async () => {
    const { root } = await repo(); await writeFile(join(root, "a.ts"), "return 2;\n"); const model = fake();
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const original = process.cwd(); process.chdir(root);
    try {
      await buildProgram({ config: { env: {} }, review: { provider: () => model.provider } }).parseAsync(["review"], { from: "user" });
      expect(log.mock.calls.flat().join("\n")).toContain("a.ts:1 (new, medium) Returning2 changes the result.");
      expect(model.calls).toHaveLength(1); expect(process.exitCode ?? 0).toBe(0);
    } finally { process.chdir(original); }
  });
  it("configured total-session caps refuse CLI and TUI before provider construction or comments", async () => {
    const { root } = await repo(); const factory = vi.fn(() => fake().provider); const processCall = vi.fn(reviewProcess);
    const original = process.cwd(); process.chdir(root);
    try {
      const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, ".agentrig"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const cap of [{ maxTokens: 100 }, { maxUsd: 1 }]) {
        await writeFile(join(root, ".agentrig", "config.json"), JSON.stringify(cap));
        await buildProgram({ config: { cwd: root, home: root, env: {} }, review: { provider: factory, process: processCall } })
          .parseAsync(["review", "--trust", "--pr", "12", "--comment", "--allow", "exec", "--allow", "net"], { from: "user" });
        expect(process.exitCode).toBe(1); process.exitCode = 0;
      }
      expect(errors.mock.calls.flat().join("\n")).toContain("select a review profile");
      const controller = new TuiController({ cwd: root, agent: { run: () => { throw new Error("no agent"); } },
        onReview: async (_args, signal) => {
          try { return renderReview(await reviewChanges(root, { ...defaults, maxTokens: "10", pr: "12", comment: true }, signal, { provider: factory, process: processCall })); }
          catch (error) { return [reviewFailure(error)]; }
        } });
      await controller.submit("/review"); expect(controller.snapshot().lines.map(line => line.text).join("\n")).toContain("select a review profile");
      await controller.shutdown(); expect(factory).not.toHaveBeenCalled(); expect(processCall).not.toHaveBeenCalled();
    } finally { process.chdir(original); }
  });
});

describe("R15e explicit PR authorization", () => {
  function transport(changed = false) {
    const calls: { args: string[]; input?: string }[] = []; let views = 0;
    const process: ReviewProcess = async (program, args, opts) => {
      expect(program).toBe("gh"); calls.push({ args: [...args], ...(opts.input === undefined ? {} : { input: opts.input }) });
      if (args[1] === "view") return JSON.stringify({ number: 12, url: "https://github.com/fixture/repo/pull/12", baseRefOid: "a".repeat(40), headRefOid: changed && ++views > 2 ? "c".repeat(40) : "b".repeat(40) });
      if (args[1] === "diff") return patch;
      if (args[1] === "comment") return "https://github.com/fixture/repo/pull/12#issuecomment-fixture\n";
      throw new Error("unexpected gh command");
    }; return { process, calls };
  }
  it("denies default/exec-only PR reads and makes no process/provider calls", async () => {
    const { root } = await repo(); const gh = transport(); const factory = vi.fn(() => fake().provider);
    for (const allow of [[], ["exec"]]) await expect(reviewChanges(root, { ...defaults, pr: "12", allow }, signal(), { process: gh.process, provider: factory })).rejects.toThrow("permission denied");
    expect(gh.calls).toHaveLength(0); expect(factory).not.toHaveBeenCalled();
  });
  it("posts only explicitly with complete valid review and exact identity; model text only reaches stdin", async () => {
    const { root } = await repo(); const gh = transport(); const model = fake();
    const result = await reviewChanges(root, { ...defaults, pr: "12", comment: true, allow: ["exec", "net"] }, signal(), { process: gh.process, provider: () => model.provider });
    expect(result.commented).toBe(true);
    const comments = gh.calls.filter(call => call.args[1] === "comment"); expect(comments).toHaveLength(1);
    expect(comments[0]?.args).toEqual(["pr", "comment", "12", "--repo", "fixture/repo", "--body-file", "-"]);
    expect(comments[0]?.input).toContain("Advisory diff review"); expect(comments[0]?.input).toContain("a.ts:1");
  });
  it("never comments on implicit requests, changed PR identity, incomplete usage or malformed review", async () => {
    const { root } = await repo();
    for (const kind of ["implicit", "changed", "usage", "malformed"]) {
      const gh = transport(kind === "changed"); const model = fake(undefined, kind !== "usage", kind === "malformed" ? "not-json" : JSON.stringify(answer));
      const run = reviewChanges(root, { ...defaults, pr: "12", comment: kind !== "implicit", allow: ["exec", "net"] }, signal(), { process: gh.process, provider: () => model.provider });
      if (kind === "implicit") await run; else await expect(run).rejects.toThrow();
      expect(gh.calls.filter(call => call.args[1] === "comment")).toHaveLength(0);
    }
  });
});

describe("R15e controller lifecycle", () => {
  it("cancels a queued request by identity without answering the active sibling", async () => {
    const { root } = await repo(); const controller = new TuiController({ cwd: root, agent: { run: () => { throw new Error("no agent"); } } });
    const first = controller.ask({ tool: "first", class: "exec", cwd: root, input: {} });
    const abort = new AbortController();
    const second = controller.ask({ tool: "second", class: "exec", cwd: root, input: {} }, undefined, abort.signal);
    expect(controller.snapshot().queued).toBe(1); abort.abort(); expect(await second).toBe("deny");
    expect(controller.snapshot().pending?.req.tool).toBe("first"); expect(controller.snapshot().queued).toBe(0);
    await controller.shutdown(); expect(await first).toBe("deny");
  });
  it("deadline settles only the exact unanswered review prompt; late answers cannot grant or drain another ask", async () => {
    const { root } = await repo(); const factory = vi.fn(() => fake().provider); const processCall = vi.fn(reviewProcess);
    const controller = new TuiController({ cwd: root, agent: { run: () => { throw new Error("no agent"); } } });
    controller.setReview(async (_args, signal) => {
      try { return renderReview(await reviewChanges(root, { ...defaults, pr: "12", maxMinutes: "0.001" }, signal, {
        provider: factory, process: processCall, ask: (req, askSignal) => controller.ask(req, { permissionGrants: controller.permissionGrants }, askSignal),
      })); } catch (error) { return [reviewFailure(error)]; }
    });
    let settled = false; const running = controller.submit("/review").then(() => { settled = true; });
    let unrelated: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(controller.snapshot().pending?.req.tool).toBe("review_gh"), { interval: 1 });
      const saved = controller.snapshot().pending!;
      unrelated = controller.ask({ tool: "unrelated", class: "exec", cwd: root, input: {} });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
      expect(controller.snapshot().pending?.req.tool).toBe("unrelated");
      saved.resolve("allow", true); expect(controller.permissionGrants.inspect()).toHaveLength(0);
      expect(controller.snapshot().pending?.req.tool).toBe("unrelated");
      expect(factory).not.toHaveBeenCalled(); expect(processCall).not.toHaveBeenCalled();
    } finally { controller.abort(); await controller.shutdown(); await running; await unrelated; }
  });
  it("reserves /review, exposes busy state, blocks other work and joins abort", async () => {
    expect(parseCommand("/review --base HEAD")).toEqual({ kind: "review", args: "--base HEAD" }); expect(RESERVED_COMMAND_NAMES.has("review")).toBe(true);
    expect(reviewArguments("--pr 12 --comment")).toEqual({ pr: "12", comment: true }); expect(() => reviewArguments("--exec x")).toThrow();
    const run = vi.fn(() => { throw new Error("agent must not run"); }); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const controller = new TuiController({ cwd: process.cwd(), agent: { run }, onReview: async (_args, signal) => {
      entered(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return ["review cancelled"];
    } });
    const reviewing = controller.submit("/review"); await ready;
    expect(controller.snapshot().reviewing).toBe(true); await controller.submit("do work"); expect(run).not.toHaveBeenCalled();
    await controller.submit("/abort"); await reviewing; expect(controller.snapshot().reviewing).toBe(false);
    await controller.shutdown();
  });
});
