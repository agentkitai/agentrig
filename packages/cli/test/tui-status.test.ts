import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAgent,
  defaultRules,
  RulePolicy,
  SessionStore,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";
import { currentGitBranch } from "../src/git-branch.ts";
import { TuiController } from "../src/tui/controller.ts";
import { formatTokens, statusLine } from "../src/tui/status.ts";

describe("formatTokens", () => {
  it("keeps small counts exact and scales the rest", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_949)).toBe("999.9k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  it("floors rather than rounds, so the gauge never overstates", () => {
    // 1,999,999 tokens is NOT two million; saying "2M" would claim context that was never sent
    expect(formatTokens(1_999_999)).toBe("1.9M");
    expect(formatTokens(1_099_000)).toBe("1M");
  });
});

describe("statusLine", () => {
  const base = {
    model: null,
    sessionId: null,
    status: "idle" as const,
    activity: null,
    turns: 0,
    context: null,
    branch: null,
  };

  it("says the minimum before anything has run", () => {
    expect(statusLine(base)).toBe("no session · idle · /help");
  });

  it("shows everything it knows, in a stable order", () => {
    expect(
      statusLine({
        model: "gpt-5.6-sol",
        sessionId: "331e27b5",
        status: "running",
        activity: null,
        turns: 3,
        context: 45_210,
        branch: "feat/r15a-eviction",
      }),
    ).toBe("gpt-5.6-sol · 331e27b5 · running · turn 3 · ctx 45.2k · ⎇ feat/r15a-eviction · /help");
  });

  it("shows wall-clock elapsed time for thinking and clamps clock skew", () => {
    expect(
      statusLine({ ...base, status: "running", activity: { kind: "thinking", startedAt: 10_000 } }, 13_999),
    ).toContain("running · thinking 3s");
    expect(
      statusLine({ ...base, status: "running", activity: { kind: "thinking", startedAt: 10_000 } }, 9_000),
    ).toContain("thinking 0s");
  });

  it("shows the running tool and optional command prefix", () => {
    expect(
      statusLine(
        {
          ...base,
          status: "running",
          activity: { kind: "tool", id: "call-1", name: "bash", detail: "pnpm test", startedAt: 1_000 },
        },
        48_900,
      ),
    ).toContain("bash pnpm test 47s");
  });

  it("omits a segment it does not know rather than printing a placeholder", () => {
    const line = statusLine({ ...base, model: "fake-1", context: null, branch: null });
    expect(line).not.toContain("ctx");
    expect(line).not.toContain("⎇");
    expect(line).toContain("fake-1");
  });
});

// ---------------------------------------------------------------- git branch

describe("currentGitBranch", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentrig-branch-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the branch from .git/HEAD, from the repo root or any directory under it", async () => {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feat/statusline\n");
    await mkdir(join(root, "packages", "cli"), { recursive: true });
    expect(currentGitBranch(root)).toBe("feat/statusline");
    expect(currentGitBranch(join(root, "packages", "cli"))).toBe("feat/statusline");
  });

  it("labels a detached HEAD instead of pretending it is a branch", async () => {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "6c8b5c754d5e6cb8e70dbebda23366a9a305bbda\n");
    expect(currentGitBranch(root)).toBe("detached 6c8b5c7");
  });

  it("follows a gitfile, because worktrees are how this project itself is used", async () => {
    const real = join(root, "main-clone", ".git", "worktrees", "wt");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "HEAD"), "ref: refs/heads/wt-branch\n");
    const wt = join(root, "wt");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${real}\n`);
    expect(currentGitBranch(wt)).toBe("wt-branch");
  });

  it("resolves a relative gitdir against the directory holding the gitfile", async () => {
    const real = join(root, "gitdirs", "sub");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "HEAD"), "ref: refs/heads/rel\n");
    const wt = join(root, "wt2");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: ../gitdirs/sub\n");
    expect(currentGitBranch(wt)).toBe("rel");
  });

  it("returns null off a repository, and on anything malformed", async () => {
    expect(currentGitBranch(root)).toBeNull();
    await mkdir(join(root, ".git"), { recursive: true });
    // no HEAD file at all
    expect(currentGitBranch(root)).toBeNull();
    await writeFile(join(root, ".git", "HEAD"), "something unexpected\n");
    expect(currentGitBranch(root)).toBeNull();
  });
});

// ---------------------------------------------------------------- controller wiring

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<ModelEvent[]>) {}
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift() ?? [{ type: "stop" as const, reason: "end_turn" as const }];
    yield* turn;
  }
}

const usage = (i: number, o: number, cacheRead?: number, cacheWrite?: number): ModelEvent => ({
  type: "usage",
  usage: {
    input: i,
    output: o,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  },
});
const stop = (): ModelEvent => ({ type: "stop", reason: "end_turn" });

describe("TuiController statusline state", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentrig-tui-status-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function make(
    turns: Array<ModelEvent[]>,
    extra: Partial<ConstructorParameters<typeof TuiController>[0]> = {},
  ): TuiController {
    const controller: TuiController = new TuiController({
      cwd: root,
      agent: createAgent({
        provider: new FakeProvider(turns),
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: z.object({}),
            permission: "read",
            execute: async () => ({ output: "ok", display: "ok" }),
          },
        ],
        permissions: new RulePolicy(defaultRules),
        systemPrompt: "test",
        store: new SessionStore({ root }),
        budget: { maxTurns: 5 },
        maxTokensPerTurn: 100,
        onAsk: async () => "allow" as const,
      }),
      ...extra,
    });
    return controller;
  }

  const consume = (controller: TuiController, event: HarnessEvent): void => {
    (controller as unknown as { consume: (next: HarnessEvent) => void }).consume(event);
  };

  it("tracks thinking until first output, then a tool until its matching result", () => {
    const c = make([]);
    consume(c, { type: "model.request", seq: 1, sessionId: "s1", ts: 1_000, tokensIn: 12 });
    expect(c.snapshot().activity).toEqual({ kind: "thinking", startedAt: 1_000 });

    consume(c, { type: "model.delta", seq: 2, sessionId: "s1", ts: 1_200, text: "hello" });
    expect(c.snapshot().activity).toBeNull();

    consume(c, {
      type: "tool.call",
      seq: 3,
      sessionId: "s1",
      ts: 2_000,
      id: "call-1",
      name: "bash",
      input: { command: "pnpm   test --filter a-command-that-is-deliberately-long" },
      inputHash: "hash",
    });
    expect(c.snapshot().activity).toEqual({
      kind: "tool",
      id: "call-1",
      name: "bash",
      startedAt: 2_000,
      detail: "pnpm test --filter a-command-th…",
    });

    consume(c, {
      type: "tool.result",
      seq: 4,
      sessionId: "s1",
      ts: 2_100,
      id: "another-call",
      ok: true,
      display: "ok",
      durationMs: 100,
    });
    expect(c.snapshot().activity?.kind).toBe("tool");

    consume(c, {
      type: "tool.result",
      seq: 5,
      sessionId: "s1",
      ts: 2_200,
      id: "call-1",
      ok: true,
      display: "ok",
      durationMs: 200,
    });
    expect(c.snapshot().activity).toBeNull();
  });

  it("clears thinking on a response even when the provider emitted no text delta", () => {
    const c = make([]);
    consume(c, { type: "model.request", seq: 1, sessionId: "s1", ts: 1_000, tokensIn: 12 });
    consume(c, {
      type: "model.response",
      seq: 2,
      sessionId: "s1",
      ts: 1_200,
      usage: { input: 1, output: 0 },
      stop: "tool_use",
    });
    expect(c.snapshot().activity).toBeNull();
  });

  it("clears stale activity when a request terminates without its normal closer", () => {
    const c = make([]);
    consume(c, { type: "model.request", seq: 1, sessionId: "s1", ts: 1_000, tokensIn: 12 });
    consume(c, {
      type: "error",
      seq: 2,
      sessionId: "s1",
      ts: 1_200,
      message: "provider failed before output",
      fatal: true,
    });
    expect(c.snapshot().activity).toBeNull();

    consume(c, { type: "model.request", seq: 3, sessionId: "s1", ts: 2_000, tokensIn: 12 });
    consume(c, {
      type: "error",
      seq: 4,
      sessionId: "s1",
      ts: 2_100,
      message: "model request refused by hook: policy",
      fatal: false,
    });
    expect(c.snapshot().activity).toBeNull();

    consume(c, { type: "model.request", seq: 5, sessionId: "s1", ts: 3_000, tokensIn: 12 });
    consume(c, { type: "turn.end", seq: 6, sessionId: "s1", ts: 3_200, n: 1 });
    expect(c.snapshot().activity).toBeNull();
  });

  it("learns the model from session.start, overriding what the flags claimed", async () => {
    const c = make([[usage(1, 1), stop()]], { model: "from-flags" });
    expect(c.snapshot().model).toBe("from-flags");
    await c.submit("hi");
    expect(c.snapshot().model).toBe("fake-1");
  });

  it("tracks the latest response's context — input + cache reads + output", async () => {
    const c = make([[usage(1_200, 34, 500), stop()]]);
    expect(c.snapshot().context).toBeNull();
    await c.submit("hi");
    expect(c.snapshot().context).toBe(1_734);
  });

  it("counts cache WRITES too — on a session's first call the cached prefix is a write", async () => {
    // Anthropic reports the just-cached system prompt as cacheWrite, not input; without it the
    // first call of a session showed a near-zero gauge
    const c = make([[usage(100, 20, 0, 3_000), stop()]]);
    await c.submit("hi");
    expect(c.snapshot().context).toBe(3_120);
  });

  it("treats all-zero usage as 'the provider reported nothing', not as ctx 0", async () => {
    // both OpenAI parsers fall back to {input: 0, output: 0} when the server sends no usage
    // frame; the gauge must keep its last honest reading rather than assert an empty context
    const c = make([
      [usage(2_000, 10), stop()],
      [usage(0, 0), stop()],
    ]);
    await c.submit("hi");
    expect(c.snapshot().context).toBe(2_010);
    await c.submit("again");
    expect(c.snapshot().context).toBe(2_010);
  });

  it("re-reads the branch at TURN end specifically, so a checkout mid-task shows", async () => {
    // The reader is consumed at construction AND at session.start before any turn ends, so the
    // switched value must only appear on the third read — an earlier version of this test flipped
    // on the second and passed even with the turn.end refresh deleted.
    const reads: string[] = [];
    const c = make([[usage(1, 1), stop()]], {
      branch: () => {
        const value = reads.length < 2 ? "main" : "feat/x";
        reads.push(value);
        return value;
      },
    });
    // read once at construction, so the line is right before anything runs
    expect(c.snapshot().branch).toBe("main");
    await c.submit("hi");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(c.snapshot().branch).toBe("feat/x");
  });

  it("survives a branch reader that throws", async () => {
    const c = make([[usage(1, 1), stop()]], {
      branch: () => {
        throw new Error("no fs today");
      },
    });
    expect(c.snapshot().branch).toBeNull();
    await c.submit("hi");
    expect(c.snapshot().status).toBe("idle");
  });

  it("/new clears the context gauge but keeps the model", async () => {
    const c = make([[usage(2_000, 10), stop()]]);
    await c.submit("hi");
    expect(c.snapshot().context).toBe(2_010);
    await c.submit("/new");
    expect(c.snapshot().context).toBeNull();
    expect(c.snapshot().model).toBe("fake-1");
  });
});
