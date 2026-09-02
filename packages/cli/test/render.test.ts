import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@agentkitai/agentrig-core";
import { AssistantText, formatUsage, renderChatEvent, renderEvent } from "../src/render.ts";

describe("formatUsage", () => {
  it("shows total input and its cached subset in compact user-facing form", () => {
    expect(formatUsage({ input: 400_000, cacheRead: 2_900_000, output: 12_345 }))
      .toBe("3.3M in (2.9M cached) / 12.3k out");
  });

  it("identifies cache writes separately from discounted cache reads", () => {
    expect(formatUsage({ input: 2_000, cacheWrite: 180_000, output: 500 }))
      .toBe("182k in (180k written) / 500 out");
  });

  it("keeps the compatible uncached form when no cache activity was reported", () => {
    expect(formatUsage({ input: 42, output: 7 })).toBe("42 in / 7 out");
  });
});

describe("renderEvent", () => {
  it("preserves labelled fields while adding cached usage to model.response traces", () => {
    const line = renderEvent(HarnessEvent.parse({
      seq: 1,
      sessionId: "s",
      ts: 1_700_000_000_000,
      type: "model.response",
      usage: { input: 400_000, cacheRead: 2_900_000, output: 12_345 },
      stop: "end_turn",
    }));
    expect(line).toContain("in=3.3M cached=2.9M out=12.3k stop=end_turn");
  });

  it("renders session.resume", () => {
    const e = HarnessEvent.parse({
      seq: 12,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "session.resume",
      task: "keep going",
      cwd: "/w",
      provider: "anthropic",
      model: "m",
    });
    const line = renderEvent(e);
    expect(line).toContain("session.resume");
    expect(line).toContain("anthropic/m");
    expect(line).toContain('"keep going"');
  });

  it("renders a tool-result overflow handle without dumping the complete output", () => {
    const line = renderEvent(HarnessEvent.parse({
      seq: 12,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "tool.result",
      id: "tool-1",
      ok: true,
      display: "visible prefix",
      durationMs: 4,
      output: "visible prefix and SECRET hidden output",
      truncated: true,
    }));
    expect(line).toContain('artifact={"seq":12,"from":0,"to":39}');
    expect(line).not.toContain("SECRET hidden output");

    const unicode = renderEvent(HarnessEvent.parse({
      seq: 13, sessionId: "abc", ts: 1_700_000_000_000, type: "tool.result",
      id: "tool-2", ok: true, display: "prefix", durationMs: 1,
      output: `${"x".repeat(29_999)}😀z`, truncated: true,
    }));
    expect(unicode).toContain('artifact={"seq":13,"from":0,"to":29999}');
  });

  it("renders context.evicted count and bytes saved", () => {
    const line = renderEvent(HarnessEvent.parse({
      seq: 13,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.evicted",
      count: 2,
      bytesSaved: 12_345,
    }));
    expect(line).toContain("context.evicted");
    expect(line).toContain("count=2");
    expect(line).toContain("saved=12345 bytes");
  });

  it("renders the compact context.manifest trace summary", () => {
    const line = renderEvent(HarnessEvent.parse({
      seq: 14,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.manifest",
      turn: 3,
      requestHash: "abc123",
      blocks: [],
    }));
    expect(line).toContain("context.manifest");
    expect(line).toContain("turn=3");
    expect(line).toContain("blocks=0");
    expect(line).toContain("request=abc123");
  });

  it("renders skill.used with who invoked it", () => {
    const line = renderEvent(HarnessEvent.parse({
      seq: 15,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "skill.used",
      name: "dogfood",
      invokedBy: "model",
    }));
    expect(line).toContain("skill.used");
    expect(line).toContain("dogfood");
    expect(line).toContain("by=model");
  });

  it("renders subagent.spawn and subagent.end, including how the child finished", () => {
    const spawned = renderEvent(
      HarnessEvent.parse({ seq: 1, sessionId: "p", ts: 1, type: "subagent.spawn", id: "c1", task: "counting files" }),
    );
    expect(spawned).toContain("subagent.spawn");
    expect(spawned).toContain("c1");
    expect(spawned).toContain("counting files");

    const ended = renderEvent(
      HarnessEvent.parse({ seq: 2, sessionId: "p", ts: 1, type: "subagent.end", id: "c1", reason: "budget" }),
    );
    expect(ended).toContain("subagent.end");
    expect(ended).toContain("budget");
    // a log written before M7 added `reason` still renders
    expect(renderEvent(HarnessEvent.parse({ seq: 3, sessionId: "p", ts: 1, type: "subagent.end", id: "c1" }))).toContain("c1");
  });

  it("names who a permission request is for when it is not this session", () => {
    const line = renderEvent(
      HarnessEvent.parse({
        seq: 4, sessionId: "p", ts: 1, type: "permission.request",
        req: { tool: "write_file", input: {}, class: "write", cwd: "/w", origin: "subagent" },
      }),
    );
    // answering "allow" for a child you cannot see is a different decision from answering it for yourself
    expect(line).toContain("subagent");
  });

  it("renders supervisor.signal with its type, confidence and evidence", () => {
    const e = HarnessEvent.parse({
      seq: 14,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.signal",
      signal: { type: "loop", confidence: 0.83, evidence: ["called bash 3x", "inputHash=deadbeef"], window: [4, 9] },
    });
    const line = renderEvent(e);
    expect(line).toContain("loop");
    expect(line).toContain("0.83");
    expect(line).toContain("called bash 3x");
    expect(line).toContain("inputHash=deadbeef");
  });

  it("renders supervisor.intervention for each kind the ladder can produce", () => {
    const kinds = [
      { type: "inject_guidance", message: "stop repeating yourself" },
      { type: "force_replan" },
      { type: "run_reviewer", reason: "loop: same call 3x" },
      { type: "run_grader", rubric: "the suite must pass" },
      { type: "escalate", question: "how should this proceed?" },
      { type: "abort", reason: "loop persisted" },
    ];
    for (const [i, intervention] of kinds.entries()) {
      const e = HarnessEvent.parse({
        seq: 20 + i,
        sessionId: "abc",
        ts: 1_700_000_000_000,
        type: "supervisor.intervention",
        intervention,
      });
      const line = renderEvent(e);
      expect(line).toContain("supervisor.intervention");
      expect(line).toContain(intervention.type);
    }
  });

  it("shows an intervention's payload rather than dumping raw JSON at the reader", () => {
    const e = HarnessEvent.parse({
      seq: 30,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.intervention",
      intervention: { type: "run_reviewer", reason: "loop: called bash with identical input 3 times" },
    });
    const line = renderEvent(e);
    expect(line).toContain("called bash with identical input 3 times");
    expect(line).not.toContain('{"type"');
  });

  it("renders update_plan's plan.updated with each step's status", () => {
    const e = HarnessEvent.parse({
      seq: 31,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "plan.updated",
      items: [
        { id: "1", text: "wire the reviewer", status: "done", scope: ["packages/supervisor/src"] },
        { id: "2", text: "write the tests", status: "in_progress" },
      ],
    });
    const line = renderEvent(e);
    expect(line).toContain("done:wire the reviewer");
    expect(line).toContain("in_progress:write the tests");
  });

  it("renders repo-map accounting without requiring its outbound-only content", () => {
    const event = HarnessEvent.parse({
      seq: 6,
      sessionId: "s",
      ts: 1,
      type: "context.repo_map",
      bytes: 4096,
      files: 42,
      truncated: false,
      freshness: "1234567890abcdef",
    });
    expect(renderEvent(event)).toContain("files=42 bytes=4096 truncated=false freshness=1234567890ab");
  });

  it("renders context.loaded with its path and byte count", () => {
    const e = HarnessEvent.parse({
      seq: 12,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.loaded",
      path: "/repo/AGENTS.md",
      bytes: 321,
    });
    const line = renderEvent(e);
    expect(line).toContain("/repo/AGENTS.md");
    expect(line).toContain("321 bytes");
  });

  it("renders context.compact", () => {
    const e = HarnessEvent.parse({
      seq: 13,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.compact",
      before: 90_000,
      after: 12_000,
    });
    expect(renderEvent(e)).toContain("90000 -> 12000");
  });
});

const at = (seq: number, payload: Record<string, unknown>): HarnessEvent =>
  HarnessEvent.parse({ seq, sessionId: "s", ts: 1_700_000_000_000, ...payload });

describe("renderChatEvent — the conversation, not the trace", () => {
  it("hides the plumbing a person waiting for an answer does not read", () => {
    const plumbing = [
      { type: "session.start", task: "t", cwd: "/w", provider: "p", model: "m" },
      { type: "session.resume", task: "t", cwd: "/w", provider: "p", model: "m" },
      { type: "turn.start", n: 1 },
      { type: "turn.end", n: 1 },
      { type: "model.request", tokensIn: 10 },
      { type: "model.delta", text: "hello" },
      { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" },
      { type: "permission.request", req: { tool: "bash", input: {}, class: "exec", cwd: "/w" } },
      { type: "permission.decision", d: "allow" },
      { type: "context.compact", before: 100, after: 50 },
      { type: "memory.note", scope: "project", path: "a.md" },
      { type: "session.end", reason: "done" },
    ];
    for (const [i, p] of plumbing.entries()) {
      expect(renderChatEvent(at(i, p)), `${String(p.type)} should be hidden`).toBeNull();
    }
  });

  it("shows what the agent did, in a form that reads", () => {
    expect(renderChatEvent(at(1, { type: "tool.call", id: "t", name: "bash", input: { command: "pnpm test" }, inputHash: "h" })))
      .toBe("⚒ bash pnpm test");
    // a successful tool is noise; a failing one explains the next turn
    expect(renderChatEvent(at(2, { type: "tool.result", id: "t", ok: true, display: "fine", durationMs: 1 }))).toBeNull();
    expect(renderChatEvent(at(3, { type: "tool.result", id: "t", ok: false, display: "boom", durationMs: 1 })))
      .toBe("✗ boom");
    expect(renderChatEvent(at(4, { type: "file.changed", path: "a.ts", op: "edit", contentHash: "h" })))
      .toBe("± edit a.ts");
  });

  it("keeps the things that need a human: errors, signals, and a session that did not finish", () => {
    expect(renderChatEvent(at(5, { type: "error", message: "it broke", fatal: true }))).toBe("! it broke");
    expect(renderChatEvent(at(6, { type: "session.end", reason: "budget" }))).toBe("— session budget");
    const signal = renderChatEvent(
      at(7, { type: "supervisor.signal", signal: { type: "loop", confidence: 0.9, evidence: ["same call x3"], window: [1, 3] } }),
    );
    expect(signal).toContain("loop");
    expect(signal).toContain("same call x3");
    const intervention = renderChatEvent(
      at(8, { type: "supervisor.intervention", intervention: { type: "inject_guidance", message: "stop repeating" } }),
    );
    expect(intervention).toContain("inject_guidance");
    expect(intervention).toContain("stop repeating");
  });

  it("summarises a plan by progress rather than reprinting every item", () => {
    const line = renderChatEvent(
      at(9, {
        type: "plan.updated",
        items: [
          { id: "a", text: "first thing", status: "done" },
          { id: "b", text: "second thing", status: "in_progress" },
          { id: "c", text: "third thing", status: "pending" },
        ],
      }),
    );
    expect(line).toBe("▸ plan 1/3: second thing");
  });

  it("never lets a multi-line value break the one-line shape", () => {
    const line = renderChatEvent(
      at(10, { type: "tool.call", id: "t", name: "bash", input: { command: "a\nb\nc" }, inputHash: "h" }),
    );
    expect(line).toBe("⚒ bash a b c");
    const long = renderChatEvent(
      at(11, { type: "tool.result", id: "t", ok: false, display: "x".repeat(500), durationMs: 1 }),
    );
    expect(long!.length).toBeLessThan(120);
    expect(long).not.toContain("\n");
  });
});

describe("AssistantText — the reply neither surface used to show", () => {
  it("gathers the deltas of a turn and emits them when it ends", () => {
    const a = new AssistantText();
    expect(a.push(at(1, { type: "turn.start", n: 1 }))).toBeNull();
    expect(a.push(at(2, { type: "model.delta", text: "The answer " }))).toBeNull();
    expect(a.push(at(3, { type: "model.delta", text: "is 42." }))).toBeNull();
    expect(a.push(at(4, { type: "turn.end", n: 1 }))).toBe("The answer is 42.");
  });

  it("emits nothing for a turn that said nothing", () => {
    const a = new AssistantText();
    expect(a.push(at(1, { type: "turn.end", n: 1 }))).toBeNull();
    a.push(at(2, { type: "model.delta", text: "   \n  " }));
    expect(a.push(at(3, { type: "turn.end", n: 2 }))).toBeNull();
  });

  it("does not run two turns together", () => {
    const a = new AssistantText();
    a.push(at(1, { type: "model.delta", text: "first" }));
    expect(a.push(at(2, { type: "turn.end", n: 1 }))).toBe("first");
    a.push(at(3, { type: "model.delta", text: "second" }));
    expect(a.push(at(4, { type: "turn.end", n: 2 }))).toBe("second");
  });

  it("flushes on session.end, so an aborted turn still reports what it said", () => {
    const a = new AssistantText();
    a.push(at(1, { type: "model.delta", text: "partial finding" }));
    expect(a.push(at(2, { type: "session.end", reason: "aborted" }))).toBe("partial finding");
  });

  it("exposes the turn in progress, for a live view", () => {
    const a = new AssistantText();
    a.push(at(1, { type: "model.delta", text: "half" }));
    expect(a.pending).toBe("half");
    a.push(at(2, { type: "turn.end", n: 1 }));
    expect(a.pending).toBe("");
  });
});

describe("model.retry rendering", () => {
  const retry = {
    seq: 1,
    sessionId: "s",
    ts: 0,
    type: "model.retry",
    attempt: 2,
    maxAttempts: 4,
    delayMs: 2000,
    reason: "overloaded",
  } as const;

  it("shows attempt, delay and reason in the event trace", () => {
    const line = renderEvent(HarnessEvent.parse(retry));
    expect(line).toContain("2/4");
    expect(line).toContain("2000ms");
    expect(line).toContain("overloaded");
  });

  it("stays out of the chat view — the provider notice already says it in words", () => {
    expect(renderChatEvent(HarnessEvent.parse(retry))).toBeNull();
  });
});
