import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgent, bashTool, updatePlanTool, SessionStore, RulePolicy, HarnessEvent,
  type EventPayload, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { RubricGrader, reportEvidence, MAX_EVIDENCE_EVENTS } from "@agentkitai/agentrig-supervisor";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const item = { id: "tests", text: "check behavior", accept: "node check.cjs exits 0", status: "done" as const };
function model(turns: ModelEvent[][]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 }, requests,
    async *stream(request) { requests.push(structuredClone(request)); yield* turns.shift() ?? [{ type: "stop", reason: "end_turn" }]; } };
}
function judge(pass = true) {
  return model([[{ type: "text_delta", text: JSON.stringify({ pass, gaps: pass ? [] : ["behavior still wrong"] }) }, { type: "stop", reason: "end_turn" }]]);
}
async function grade(events: HarnessEvent[], pass = true) {
  const provider = judge(pass);
  const result = await new RubricGrader({ provider }).grade({ rubric: "the change works", artifacts: [], trajectory: events });
  return { provider, result };
}
async function actualSession(finalCode: number) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-evidence-grading-")); roots.push(root);
  await writeFile(join(root, "check.cjs"), `const fs=require('node:fs'); const second=fs.existsSync('ran'); fs.writeFileSync('ran','yes'); console.log('ALL PASSED'); process.exit(second ? ${finalCode} : 0);`);
  const call = (name: string, input: unknown): ModelEvent[] => [{ type: "tool_use", id: "reused", name, input }, { type: "stop", reason: "tool_use" }];
  const provider = model([call("update_plan", { items: [item] }), call("bash", { command: "node check.cjs" }),
    call("bash", { command: "node check.cjs" }), [{ type: "text_delta", text: "Everything is complete and passes." }, { type: "stop", reason: "end_turn" }]]);
  const store = new SessionStore({ root: join(root, "logs") });
  const session = createAgent({ provider, store, tools: [updatePlanTool(), bashTool()], systemPrompt: "fixture", repoMap: false,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "allow" }]) }).run("verify", { cwd: root });
  await session.done; return store.readAll(session.id);
}
it("actual passing/failing final runs discriminate despite identical optimistic fake grader and completion narration", async () => {
  const good = await actualSession(0); const bad = await actualSession(1);
  const passing = await grade(good); const failing = await grade(bad);
  expect(passing.result).toEqual({ pass: true, gaps: [] });
  expect(failing.result.pass).toBe(false);
  expect(failing.result.gaps.join("\n")).toMatch(/tests.*latest exit mismatch/);
  expect(passing.provider.requests).toHaveLength(1); expect(failing.provider.requests).toHaveLength(1);
  expect(failing.provider.requests[0]!.system).toContain("Claims-vs-evidence rubric row");
  const prompt = JSON.stringify(failing.provider.requests[0]!.messages);
  expect(prompt).toContain("latest exit mismatch"); expect(prompt).toContain("result#");
  expect((await grade(good, false)).result).toEqual({ pass: false, gaps: ["behavior still wrong"] });
});

function trajectory(items: Array<{ id: string; text: string; status: "done" | "pending" | "in_progress" | "dropped"; accept?: string }>, code: number | null = 0) {
  const out: HarnessEvent[] = [];
  const push = (event: EventPayload) => { out.push(HarnessEvent.parse({ ...event, seq: out.length, sessionId: "s", ts: 1 })); };
  push({ type: "session.start", task: "test", cwd: "/project", provider: "fixture", model: "fixture" });
  push({ type: "plan.updated", items });
  if (code !== null) {
    push({ type: "tool.call", id: "call", name: "bash", input: { command: "node check.cjs" }, inputHash: "x" });
    push({ type: "tool.result", id: "call", ok: code === 0, display: "secret raw stdout never in report", durationMs: 1, toolCallSeq: 2,
      commandOutcome: { command: "node check.cjs", cwd: "/project", exitCode: code, timedOut: false, aborted: false } });
  }
  push({ type: "session.end", reason: "done" }); return out;
}
it.each(["pending", "in_progress"] as const)("declared %s remains unfinished even with a matching candidate", async status => {
  const result = await grade(trajectory([{ ...item, status }]));
  expect(result.result.pass).toBe(false); expect(result.result.gaps.join()).toContain("unfinished plan item");
});
it("dropped and legacy items are shown but do not force new completion requirements", async () => {
  const dropped = trajectory([{ ...item, status: "dropped" }], 1);
  expect((await grade(dropped)).result.pass).toBe(true);
  expect(reportEvidence(dropped).text).toContain("dropped; not a required completion claim");
  const legacy = trajectory([{ id: "old", text: "old", status: "done" }]);
  const original = await grade(legacy);
  expect(original.result).toEqual({ pass: true, gaps: [] });
  expect(original.provider.requests[0]!.system).not.toContain("Claims-vs-evidence rubric row");
  expect(reportEvidence(legacy).text).toContain("undeclared"); expect(reportEvidence(legacy).text).toContain("unverified");
});
it.each(["endpoint returns 401", item.accept])("unsupported or unmatched %s stays unverified", async accept => {
  const events = trajectory([{ ...item, accept }], null);
  expect((await grade(events)).result.pass).toBe(false);
  expect(reportEvidence(events).text).toContain("unverified");
});
it("row/character and event omissions are bounded, visible and cannot hide a deficit", async () => {
  const large = trajectory(Array.from({ length: 101 }, (_, i) => ({ ...item, id: String(i), text: "x".repeat(1800) })));
  const report = reportEvidence(large);
  expect(report.text.length).toBeLessThanOrEqual(12000); expect(report.incomplete).toBe(true);
  expect(report.text).toContain("omitted rows"); expect((await grade(large)).result.pass).toBe(false);
  const tooMany = Array.from({ length: MAX_EVIDENCE_EVENTS + 1 }, (_, seq) => HarnessEvent.parse({ type: "model.delta", text: "", seq, sessionId: "s", ts: 1 }));
  const overflow = reportEvidence(tooMany);
  expect(overflow.incomplete).toBe(true); expect(overflow.finished).toBe(false); expect(overflow.gaps.join()).toContain("omitted events 1");
});
it("many concrete deficits remain a failing bounded gap list even when later rows are omitted", async () => {
  const events = trajectory(Array.from({ length: 100 }, (_, i) => ({ ...item, id: String(i) })), null);
  const { result } = await grade(events);
  expect(result.pass).toBe(false); expect(result.gaps.length).toBeLessThanOrEqual(33);
  expect(result.gaps.join()).toContain("further acceptance gaps omitted");
  expect(reportEvidence(events).text).not.toContain("secret raw stdout");
});
