import { describe, expect, it } from "vitest";
import type { EventPayload, HarnessEvent, ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import {
  GradeSchema,
  RubricGrader,
  TrajectoryReviewer,
  condenseTrajectory,
  extractJson,
  extractJsonCandidates,
  lastValid,
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
    // the truncation marker counts against the budget, or maxPromptChars would not be a bound
    expect(prompt.length).toBeLessThanOrEqual(3000);
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

  it("FAILS CLOSED across every malformed shape", async () => {
    for (const bad of [
      "looks good to me!",
      '{"pass":"yes"}',
      '{"gaps":[]}',
      "null",
      '[{"pass":true}]',
      "",
    ]) {
      const out = await new RubricGrader({ provider: scripted(bad) }).grade({
        rubric: "r",
        artifacts,
        trajectory: [],
      });
      expect(out.pass).toBe(false);
    }
  });

  it("does NOT certify the work on an echoed format example", async () => {
    // taking the first balanced object meant the model's own schema echo won, and the supervisor
    // silently steered nothing — PLAN §4.3 calls this worse than having no grader at all
    const provider = scripted(
      'Reply shape: {"pass": true, "gaps": []}\nMy verdict: {"pass": false, "gaps": ["no tests added"]}',
    );
    const out = await new RubricGrader({ provider }).grade({ rubric: "r", artifacts, trajectory: [] });
    expect(out.pass).toBe(false);
    expect(out.gaps).toEqual(["no tests added"]);
  });

  it("counts unread artifacts against the budget too", async () => {
    const provider = scripted(JSON.stringify({ pass: true, gaps: [] }));
    await new RubricGrader({ provider, maxArtifactChars: 200 }).grade({
      rubric: "r",
      artifacts: Array.from({ length: 500 }, (_, i) => ({ path: `some/long/path/to/file-${i}.ts` })),
      trajectory: [],
    });
    // N named-but-unread paths used to grow the prompt without limit
    expect(promptOf(provider).length).toBeLessThan(2000);
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
    expect(extractJson('{"unterminated": "string')).toBeNull();
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

  it("is not defeated by brackets in the prose before the payload", () => {
    // returning at the FIRST balanced value consumed `[see below]`, failed to parse it, and
    // discarded the whole reply
    expect(extractJsonCandidates('Note [see below]. {"pass":false,"gaps":["g"]}')).toContainEqual({
      pass: false,
      gaps: ["g"],
    });
  });

  it("does not let an empty object in the prose win", () => {
    const found = extractJsonCandidates('Use {} for defaults.\n{"pass":false,"gaps":["g"]}');
    expect(found).toContainEqual({ pass: false, gaps: ["g"] });
  });

  it("scans top-level values only, so a nested object is not a separate candidate", () => {
    const found = extractJsonCandidates('{"outer":{"inner":1}}');
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ outer: { inner: 1 } });
  });

  it("handles a top-level array", () => {
    expect(extractJson('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("lastValid", () => {
  const grade = (v: unknown) => GradeSchema.safeParse(v);

  it("takes the LAST schema-valid object, not the first", () => {
    // a model echoing the format, or thinking aloud, puts its real verdict at the end
    const text = 'Format: {"pass": true, "gaps": []}\n{"pass": false, "gaps": ["missing tests"]}';
    expect(lastValid(text, grade)).toEqual({ pass: false, gaps: ["missing tests"] });
  });

  it("skips trailing objects that do not satisfy the schema", () => {
    const text = '{"pass":false,"gaps":["real"]}\n{"note":"not a verdict"}';
    expect(lastValid(text, grade)).toEqual({ pass: false, gaps: ["real"] });
  });

  it("returns null when nothing validates", () => {
    expect(lastValid('{"note":"nope"}', grade)).toBeNull();
  });
});
