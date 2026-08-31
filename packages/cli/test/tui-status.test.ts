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
  const base = { model: null, sessionId: null, status: "idle" as const, turns: 0, context: null, branch: null };

  it("says the minimum before anything has run", () => {
    expect(statusLine(base)).toBe("no session · idle · /help");
  });

  it("shows everything it knows, in a stable order", () => {
    expect(
      statusLine({
        model: "gpt-5.6-sol",
        sessionId: "331e27b5",
        status: "running",
        turns: 3,
        context: 45_210,
        branch: "feat/r15a-eviction",
      }),
    ).toBe("gpt-5.6-sol · 331e27b5 · running · turn 3 · ctx 45.2k · ⎇ feat/r15a-eviction · /help");
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

const usage = (i: number, o: number, cacheRead?: number): ModelEvent => ({
  type: "usage",
  usage: { input: i, output: o, ...(cacheRead === undefined ? {} : { cacheRead }) },
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

  it("re-reads the branch at turn end, so a checkout mid-task shows", async () => {
    const branches = ["main", "feat/x"];
    let reads = 0;
    const c = make([[usage(1, 1), stop()]], {
      branch: () => {
        reads += 1;
        return branches.shift() ?? "feat/x";
      },
    });
    // read once at construction, so the line is right before anything runs
    expect(c.snapshot().branch).toBe("main");
    await c.submit("hi");
    expect(reads).toBeGreaterThan(1);
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
