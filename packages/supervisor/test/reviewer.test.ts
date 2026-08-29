import { describe, expect, it } from "vitest";
import type { EventPayload, HarnessEvent, ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import {
  RubricGrader,
  TrajectoryReviewer,
  condenseTrajectory,
  extractJson,
  renderAttempts,
  type Attempt,
} from "@agentkitai/agentrig-supervisor";

function scripted(text: string): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push(req);
      yield { type: "text_delta", text };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

let seq = 0;
const ev = (payload: EventPayload): HarnessEvent => ({ seq: seq++, sessionId: "s", ts: 1, ...payload } as HarnessEvent);
const promptOf = (p: { calls: ModelRequest[] }): string =>
  (p.calls[0]!.messages[0]!.content[0] as { text: string }).text;

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: "a1", sessionId: "s1", ts: 0, hypothesis: "the config is wrong",
  actions: "edited config.json", outcome: "failed", evidence: [], ...over,
});

describe("TrajectoryReviewer", () => {
  it("returns the diagnosis, directions and guidance the model produced", async () => {
    const provider = scripted(
      JSON.stringify({
        diagnosis: "it is editing the wrong file",
        directions: ["check which file the test imports", "print the resolved path"],
        guidance: "Stop editing config.json and find what the test actually loads.",
      }),
    );
    const out = await new TrajectoryReviewer({ provider }).review({ task: "fix the test", trajectory: [] });
    expect(out.diagnosis).toBe("it is editing the wrong file");
    expect(out.directions).toHaveLength(2);
    expect(out.guidance).toContain("config.json");
  });

  it("puts the attempts ledger in the prompt — the thing AVO lacked", async () => {
    const provider = scripted(JSON.stringify({ diagnosis: "d", directions: [], guidance: "g" }));
    await new TrajectoryReviewer({ provider }).review({
      task: "t",
      trajectory: [],
      attempts: [attempt({ hypothesis: "swap the adapter", lesson: "the adapter was never the problem" })],
    });
    const prompt = promptOf(provider);
    expect(prompt).toContain("Attempts ledger");
    expect(prompt).toContain("swap the adapter");
    expect(prompt).toContain("the adapter was never the problem");
  });

  it("does not crash on a model that answers in prose", async () => {
    const out = await new TrajectoryReviewer({ provider: scripted("I think you should try harder.") }).review({
      task: "t",
      trajectory: [],
    });
    expect(out.guidance).toBe("");
    expect(out.diagnosis).toContain("could not be parsed");
  });

  it("tolerates a fenced JSON reply", async () => {
    const provider = scripted('```json\n{"diagnosis":"d","directions":["a"],"guidance":"g"}\n```');
    expect((await new TrajectoryReviewer({ provider }).review({ task: "t", trajectory: [] })).guidance).toBe("g");
  });

  it("bounds the prompt and keeps the TAIL of a long trajectory", async () => {
    const provider = scripted(JSON.stringify({ diagnosis: "d", directions: [], guidance: "g" }));
    const trajectory = Array.from({ length: 400 }, (_, i) =>
      ev({ type: "tool.call", id: `t${i}`, name: "bash", input: { cmd: `step-${i}-${"x".repeat(300)}` }, inputHash: "h" }),
    );
    await new TrajectoryReviewer({ provider, maxPromptChars: 3000 }).review({ task: "t", trajectory });
    const prompt = promptOf(provider);
    expect(prompt.length).toBeLessThan(4000);
    // what it just did matters more than how it opened
    expect(prompt).toContain("step-399");
    expect(prompt).not.toContain("step-0-");
  });
});

describe("condenseTrajectory", () => {
  it("keeps the events a reviewer reasons from and drops the noise", () => {
    const text = condenseTrajectory([
      ev({ type: "turn.start", n: 1 }),
      ev({ type: "model.delta", text: "thinking out loud at length" }),
      ev({ type: "tool.call", id: "1", name: "bash", input: { cmd: "pnpm test" }, inputHash: "h" }),
      ev({ type: "tool.result", id: "1", ok: false, display: "2 failed", durationMs: 1 }),
      ev({ type: "file.changed", path: "src/a.ts", op: "edit", contentHash: "c" }),
      ev({ type: "plan.updated", items: [{ id: "1", text: "do it", status: "in_progress" }] }),
    ]);
    expect(text).toContain("turn 1");
    expect(text).toContain("call bash");
    expect(text).toContain("ERROR 2 failed");
    expect(text).toContain("changed src/a.ts");
    expect(text).toContain("plan:");
    // token-hungry and useless for diagnosis
    expect(text).not.toContain("thinking out loud");
  });

  it("marks a successful result as ok and a failed one as ERROR", () => {
    const text = condenseTrajectory([
      ev({ type: "tool.result", id: "1", ok: true, display: "fine", durationMs: 1 }),
      ev({ type: "tool.result", id: "2", ok: false, display: "boom", durationMs: 1 }),
    ]);
    expect(text).toContain("-> ok fine");
    expect(text).toContain("-> ERROR boom");
  });
});

describe("renderAttempts", () => {
  it("says so plainly when the ledger is empty", () => {
    expect(renderAttempts([])).toContain("no attempts recorded");
  });

  it("includes the outcome and the lesson", () => {
    const text = renderAttempts([attempt({ outcome: "reverted", lesson: "it was the cache" })]);
    expect(text).toContain("[reverted]");
    expect(text).toContain("lesson: it was the cache");
  });
});

describe("RubricGrader", () => {
  const artifacts = [{ path: "src/a.ts", content: "export const x = 1;" }];

  it("passes work that meets the rubric", async () => {
    const provider = scripted(JSON.stringify({ pass: true, gaps: [] }));
    const out = await new RubricGrader({ provider }).grade({ rubric: "x is exported", artifacts, trajectory: [] });
    expect(out.pass).toBe(true);
  });

  it("fails with concrete gaps", async () => {
    const provider = scripted(JSON.stringify({ pass: false, gaps: ["no test covers x", "y is still missing"] }));
    const out = await new RubricGrader({ provider }).grade({ rubric: "x and y", artifacts, trajectory: [] });
    expect(out.pass).toBe(false);
    expect(out.gaps).toHaveLength(2);
  });

  it("FAILS CLOSED when its own response cannot be parsed", async () => {
    // defaulting to pass would mean a broken grader silently certifies everything, which is
    // strictly worse than having no grader at all
    const out = await new RubricGrader({ provider: scripted("looks good to me!") }).grade({
      rubric: "r",
      artifacts,
      trajectory: [],
    });
    expect(out.pass).toBe(false);
    expect(out.gaps[0]).toContain("could not be parsed");
  });

  it("sends the artifacts, and marks the ones it could not read", async () => {
    const provider = scripted(JSON.stringify({ pass: true, gaps: [] }));
    await new RubricGrader({ provider }).grade({
      rubric: "r",
      artifacts: [{ path: "src/a.ts", content: "CONTENT_HERE" }, { path: "src/b.ts" }],
      trajectory: [],
    });
    const prompt = promptOf(provider);
    expect(prompt).toContain("CONTENT_HERE");
    expect(prompt).toContain("src/b.ts\n(not read)");
  });

  it("bounds artifact content", async () => {
    const provider = scripted(JSON.stringify({ pass: true, gaps: [] }));
    await new RubricGrader({ provider, maxArtifactChars: 500 }).grade({
      rubric: "r",
      artifacts: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, content: "z".repeat(400) })),
      trajectory: [],
    });
    expect(promptOf(provider).length).toBeLessThan(3000);
  });
});

describe("extractJson", () => {
  it("returns null instead of throwing, so a bad reply is never fatal", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("")).toBeNull();
    expect(extractJson("{ broken")).toBeNull();
  });

  it("finds a balanced object inside surrounding prose", () => {
    expect(extractJson('Sure! {"pass":true,"gaps":[]} hope that helps')).toEqual({ pass: true, gaps: [] });
  });

  it("does not stop at a brace inside a string", () => {
    expect(extractJson('{"guidance":"use {} carefully","directions":[]}')).toEqual({
      guidance: "use {} carefully",
      directions: [],
    });
  });
});
