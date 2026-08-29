import { describe, expect, it } from "vitest";
import type { EventPayload, HarnessEvent, Signal } from "@agentkitai/agentrig-core";
import {
  budgetDetector,
  declaredScope,
  driftDetector,
  errorBurstDetector,
  errorFingerprint,
  inScope,
  initialState,
  loopDetector,
  parseTestCounts,
  reduce,
  stallDetector,
  testRegressionDetector,
  type Detector,
  type StateOptions,
  type SupervisorState,
} from "@agentkitai/agentrig-supervisor";

let seq = 0;
function ev(payload: EventPayload, ts = 1_000): HarnessEvent {
  return { seq: seq++, sessionId: "s", ts, ...payload } as HarnessEvent;
}

/** Feeds events through the same fold + observe path attach() uses, returning every signal. */
function feed(
  detector: Detector,
  events: HarnessEvent[],
  opts: StateOptions = {},
): { signals: Signal[]; state: SupervisorState } {
  const state = initialState();
  const signals: Signal[] = [];
  for (const e of events) {
    reduce(state, e, opts);
    const s = detector.observe(e, state);
    if (s !== null) signals.push(s);
  }
  return { signals, state };
}

const call = (name: string, hash: string) => ev({ type: "tool.call", id: `c${seq}`, name, input: {}, inputHash: hash });
const result = (ok: boolean, display: string) => ev({ type: "tool.result", id: `c${seq}`, ok, display, durationMs: 1 });
const changed = (path: string, contentHash: string) =>
  ev({ type: "file.changed", path, op: "edit", contentHash });
const turnEnd = () => ev({ type: "turn.end", n: 1 });

describe("loop detector", () => {
  it("fires on the same tool input hash repeating k times", () => {
    const { signals } = feed(loopDetector({ repeats: 3 }), [call("bash", "h1"), call("bash", "h1"), call("bash", "h1")]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("loop");
    expect(signals[0]!.evidence.join(" ")).toContain("identical input 3 times");
  });

  it("does not fire on distinct inputs, however many", () => {
    const calls = Array.from({ length: 20 }, (_, i) => call("bash", `h${i}`));
    expect(feed(loopDetector({ repeats: 3 }), calls).signals).toHaveLength(0);
  });

  it("re-arms rather than firing on every subsequent repeat", () => {
    const calls = Array.from({ length: 6 }, () => call("bash", "same"));
    // 6 identical calls at k=3 is two loops, not four signals
    expect(feed(loopDetector({ repeats: 3 }), calls).signals).toHaveLength(2);
  });

  it("fires on the same error recurring, even when the text has volatile ids in it", () => {
    const errs = [
      result(false, "ENOENT: no such file /tmp/x-a1b2c3d4e5f6/out.txt after 12ms"),
      result(false, "ENOENT: no such file /tmp/x-99887766aabb/out.txt after 340ms"),
      result(false, "ENOENT: no such file /tmp/x-0f0f0f0f0f0f/out.txt after 7ms"),
    ];
    const { signals } = feed(loopDetector({ repeats: 3 }), errs);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]).toContain("same tool error came back 3 times");
  });

  it("ignores successful results no matter how identical", () => {
    const oks = Array.from({ length: 8 }, () => result(true, "same output"));
    expect(feed(loopDetector({ repeats: 3 }), oks).signals).toHaveLength(0);
  });

  it("fires on edit→revert thrash on one file", () => {
    const { signals } = feed(loopDetector({ reverts: 2 }), [
      changed("a.ts", "A"),
      changed("a.ts", "B"),
      changed("a.ts", "A"), // revert 1
      changed("a.ts", "B"), // revert 2
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]).toContain("edited back to a previous version");
  });

  it("does not call steady forward progress a revert", () => {
    const { signals } = feed(loopDetector({ reverts: 2 }), [
      changed("a.ts", "A"),
      changed("a.ts", "B"),
      changed("a.ts", "C"),
      changed("a.ts", "D"),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("keeps per-file revert tallies separate", () => {
    // one revert on each of two files is not two reverts on one file
    const { signals } = feed(loopDetector({ reverts: 2 }), [
      changed("a.ts", "A"),
      changed("a.ts", "B"),
      changed("a.ts", "A"),
      changed("b.ts", "X"),
      changed("b.ts", "Y"),
      changed("b.ts", "X"),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("errorFingerprint collapses volatile parts but keeps the message distinct", () => {
    expect(errorFingerprint("timeout after 30s at 0xdeadbeef")).toBe(
      errorFingerprint("timeout after 5s at 0xcafef00d"),
    );
    expect(errorFingerprint("ENOENT foo")).not.toBe(errorFingerprint("EACCES foo"));
  });
});

describe("stall detector", () => {
  it("fires after N quiet turns", () => {
    const { signals } = feed(stallDetector({ turns: 3 }), [
      call("bash", "a"), // first use of bash is exploration, so this turn counts as productive
      turnEnd(),
      call("bash", "b"),
      turnEnd(),
      call("bash", "c"),
      turnEnd(),
      call("bash", "d"),
      turnEnd(),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("stall");
  });

  it("a turn that changes a file resets the count", () => {
    const { signals } = feed(stallDetector({ turns: 3 }), [
      turnEnd(),
      turnEnd(),
      changed("a.ts", "A"),
      turnEnd(), // productive: resets the tally
      turnEnd(),
      turnEnd(),
      turnEnd(),
    ]);
    // without the reset the first two quiet turns would have completed a run of three; they
    // don't, and the signal comes only from the three quiet turns after the file change
    expect(signals).toHaveLength(1);
  });

  it("a turn that reaches for a new tool kind counts as progress", () => {
    const { signals } = feed(stallDetector({ turns: 3 }), [
      call("bash", "a"),
      turnEnd(),
      call("grep", "b"),
      turnEnd(),
      call("read_file", "c"),
      turnEnd(),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("fires when repeated test runs report an identical pass count", () => {
    const runs = Array.from({ length: 3 }, () => result(true, "Tests  4 failed | 40 passed (44)"));
    const { signals } = feed(stallDetector({ testRuns: 3 }), runs);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]).toContain("40 passed / 4 failed");
  });

  it("a changed pass count is not a stall", () => {
    const { signals } = feed(stallDetector({ testRuns: 3 }), [
      result(true, "Tests  4 failed | 40 passed (44)"),
      result(true, "Tests  3 failed | 41 passed (44)"),
      result(true, "Tests  2 failed | 42 passed (44)"),
    ]);
    expect(signals).toHaveLength(0);
  });
});

describe("error_burst detector", () => {
  it("fires when the recent failure rate crosses the threshold", () => {
    const events = [result(false, "e1"), result(false, "e2"), result(true, "ok"), result(false, "e3")];
    const { signals } = feed(errorBurstDetector({ window: 10, threshold: 0.5, minSamples: 4 }), events);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]).toContain("3 of the last 4 tool calls failed");
  });

  it("never fires below minSamples, however bad the rate", () => {
    const { signals } = feed(errorBurstDetector({ minSamples: 4 }), [result(false, "e"), result(false, "e")]);
    expect(signals).toHaveLength(0);
  });

  it("a healthy run produces nothing", () => {
    const oks = Array.from({ length: 12 }, () => result(true, "fine"));
    expect(feed(errorBurstDetector(), oks).signals).toHaveLength(0);
  });

  it("counts only the window, so an old burst ages out", () => {
    const events = [result(false, "e"), ...Array.from({ length: 12 }, () => result(true, "ok"))];
    // one old failure never lifts the windowed rate to the threshold again; a detector that
    // tallied failures for the whole session instead of the last M would fire here
    const { signals } = feed(errorBurstDetector({ window: 4, threshold: 0.5, minSamples: 4 }), events);
    expect(signals).toHaveLength(0);
  });

  it("recovers cleanly: a burst fires once and the successes after it do not re-fire", () => {
    const events = [
      ...Array.from({ length: 4 }, () => result(false, "e")),
      ...Array.from({ length: 12 }, () => result(true, "ok")),
    ];
    expect(feed(errorBurstDetector({ window: 4, threshold: 0.5, minSamples: 4 }), events).signals).toHaveLength(1);
  });

  it("3 of the last 4 failing is a burst even with one success mixed in", () => {
    const events = [result(false, "e"), result(false, "e"), result(false, "e"), result(true, "ok")];
    expect(feed(errorBurstDetector({ window: 4, threshold: 0.5, minSamples: 4 }), events).signals).toHaveLength(1);
  });
});

describe("budget detector", () => {
  it("warns once per dimension at the soft threshold", () => {
    const turns = Array.from({ length: 9 }, () => turnEnd());
    const { signals } = feed(budgetDetector({ soft: 0.8, maxTurns: 10 }), turns);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("budget");
    expect(signals[0]!.evidence[0]).toContain("turns budget");
  });

  it("stays quiet below the threshold", () => {
    const turns = Array.from({ length: 5 }, () => turnEnd());
    expect(feed(budgetDetector({ soft: 0.8, maxTurns: 10 }), turns).signals).toHaveLength(0);
  });

  it("prices tokens into a USD threshold", () => {
    const events = [ev({ type: "model.response", usage: { input: 1_000_000, output: 0 }, stop: "end_turn" })];
    const { signals } = feed(budgetDetector({ soft: 0.8, maxUsd: 1 }), events, {
      pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    });
    expect(signals[0]!.evidence[0]).toContain("usd budget");
  });

  it("uses wall clock from session.start, and a resume restarts it", () => {
    const start = ev({ type: "session.start", task: "t", cwd: "/w", provider: "p", model: "m" }, 0);
    const late = ev({ type: "turn.end", n: 1 }, 9 * 60_000);
    expect(feed(budgetDetector({ soft: 0.8, maxMinutes: 10 }), [start, late]).signals).toHaveLength(1);

    const resumed = ev({ type: "session.resume", task: "t", cwd: "/w", provider: "p", model: "m" }, 8 * 60_000);
    const soon = ev({ type: "turn.end", n: 1 }, 9 * 60_000);
    expect(feed(budgetDetector({ soft: 0.8, maxMinutes: 10 }), [start, resumed, soon]).signals).toHaveLength(0);
  });

  it("with no limits configured it can never fire", () => {
    const turns = Array.from({ length: 200 }, () => turnEnd());
    expect(feed(budgetDetector(), turns).signals).toHaveLength(0);
  });
});

describe("test_regression detector", () => {
  it("fires when the pass count drops below the best seen", () => {
    const { signals } = feed(testRegressionDetector(), [
      result(true, "Tests  250 passed (250)"),
      result(true, "Tests  260 passed (260)"),
      result(false, "Tests  9 failed | 251 passed (260)"),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]).toContain("dropped from 260 to 251");
  });

  it("a monotonically growing suite never fires", () => {
    const { signals } = feed(testRegressionDetector(), [
      result(true, "Tests  10 passed (10)"),
      result(true, "Tests  20 passed (20)"),
      result(true, "Tests  30 passed (30)"),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("added failures with no lost passes are progress, not regression", () => {
    // a newly written test that does not pass yet: passed stays 30, failed goes 0 -> 2
    const { signals } = feed(testRegressionDetector(), [
      result(true, "Tests  30 passed (30)"),
      result(false, "Tests  2 failed | 30 passed (32)"),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("non-test output never establishes a baseline", () => {
    const { signals } = feed(testRegressionDetector(), [
      result(true, "Tests  30 passed (30)"),
      result(true, "total 48\ndrwxr-xr-x 3 user user 4096 Aug 29 19:00 src"),
      result(true, "Tests  30 passed (30)"),
    ]);
    expect(signals).toHaveLength(0);
  });
});

describe("drift detector", () => {
  const plan = (scope: string[]) =>
    ev({ type: "plan.updated", items: [{ id: "1", text: "do it", status: "in_progress", scope }] });

  it("fires on a file outside every declared scope", () => {
    const { signals } = feed(driftDetector(), [plan(["packages/core/src"]), changed("packages/cli/src/x.ts", "h")]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("drift");
    expect(signals[0]!.evidence[0]).toContain("packages/cli/src/x.ts");
  });

  it("stays silent for files inside the scope", () => {
    const { signals } = feed(driftDetector(), [
      plan(["packages/core/src"]),
      changed("packages/core/src/a.ts", "h"),
      changed("packages/core/src/deep/b.ts", "h"),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("cannot fire when no plan item declares a scope", () => {
    const noScope = ev({ type: "plan.updated", items: [{ id: "1", text: "do it", status: "in_progress" }] });
    expect(feed(driftDetector(), [noScope, changed("anything.ts", "h")]).signals).toHaveLength(0);
    // and with no plan at all
    expect(feed(driftDetector(), [changed("anything.ts", "h")]).signals).toHaveLength(0);
  });

  it("reports each stray path once, not on every subsequent edit", () => {
    const { signals } = feed(driftDetector(), [
      plan(["src"]),
      changed("other.ts", "h1"),
      changed("other.ts", "h2"),
      changed("other.ts", "h3"),
    ]);
    expect(signals).toHaveLength(1);
  });

  it("a dropped plan item's scope no longer counts", () => {
    const dropped = ev({
      type: "plan.updated",
      items: [
        { id: "1", text: "a", status: "dropped", scope: ["src"] },
        { id: "2", text: "b", status: "in_progress", scope: ["docs"] },
      ],
    });
    expect(feed(driftDetector(), [dropped, changed("src/a.ts", "h")]).signals).toHaveLength(1);
  });

  it("inScope treats a scope entry as an exact path or a directory prefix", () => {
    expect(inScope("src/a.ts", ["src"])).toBe(true);
    expect(inScope("src/a.ts", ["src/"])).toBe(true);
    expect(inScope("./src/a.ts", ["src"])).toBe(true);
    expect(inScope("src/a.ts", ["src/a.ts"])).toBe(true);
    // the prefix must end at a path boundary, or "src" would swallow "srcfoo"
    expect(inScope("srcfoo/a.ts", ["src"])).toBe(false);
    expect(inScope("packages/cli/x.ts", ["packages/core"])).toBe(false);
  });

  it("declaredScope gathers every non-dropped item's scope", () => {
    expect(
      declaredScope([
        { id: "1", text: "a", status: "done", scope: ["a"] },
        { id: "2", text: "b", status: "dropped", scope: ["b"] },
        { id: "3", text: "c", status: "pending" },
      ]),
    ).toEqual(["a"]);
  });
});

describe("parseTestCounts", () => {
  it("reads vitest, jest, pytest, mocha and go", () => {
    expect(parseTestCounts("Tests  1 failed | 259 passed (260)")).toEqual({ passed: 259, failed: 1 });
    expect(parseTestCounts(" Tests  260 passed (260)")).toEqual({ passed: 260, failed: 0 });
    expect(parseTestCounts("Tests:       2 failed, 5 passed, 7 total")).toEqual({ passed: 5, failed: 2 });
    expect(parseTestCounts("===== 5 passed, 2 failed in 0.12s =====")).toEqual({ passed: 5, failed: 2 });
    expect(parseTestCounts("  5 passing (12ms)\n  2 failing")).toEqual({ passed: 5, failed: 2 });
    expect(parseTestCounts("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- PASS: TestC")).toEqual({
      passed: 2,
      failed: 1,
    });
  });

  it("returns null for output that is not a test run", () => {
    expect(parseTestCounts("total 48\ndrwxr-xr-x 3 user user 4096 src")).toBeNull();
    expect(parseTestCounts("")).toBeNull();
    expect(parseTestCounts("Compiled 12 modules in 300ms")).toBeNull();
  });
});
