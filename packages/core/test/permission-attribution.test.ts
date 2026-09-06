import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, evaluatePermissionPolicy, HarnessEvent, PermissionGrantRegistry, RulePolicy, SessionStore,
  type AnyTool, type Decision, type ModelEvent, type ModelProvider, type PermissionPolicy, type PermissionPolicyReceipt, type PermissionRequest } from "@agentkitai/agentrig-core";

const req: PermissionRequest = { tool: "probe", class: "exec", cwd: resolve("."), input: {} };
const receipt: PermissionPolicyReceipt = { decision: "allow", source: { kind: "rule", index: 2, rule: { tool: "probe", decision: "allow" } } };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("same-call policy attribution", () => {
  it("reports the actual first matched rule and fallback without re-evaluation", async () => {
    const policy = new RulePolicy([{ tool: "other", decision: "deny" }, { tool: "probe", decision: "allow" }, { tool: "probe", decision: "deny" }]);
    const spy = vi.spyOn(policy, "decide");
    expect(await evaluatePermissionPolicy(policy, req)).toEqual(receipt);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await evaluatePermissionPolicy(policy, { ...req, tool: "missing" })).toEqual({ decision: "ask", source: { kind: "fallback" } });
  });
  it("preserves custom and subclass overrides with honest unknown attribution", async () => {
    class Override extends RulePolicy { calls = 0; override async decide(): Promise<Decision> { this.calls++; return "deny"; } }
    const policy = new Override([{ tool: "probe", decision: "allow" }]);
    expect(await evaluatePermissionPolicy(policy, req)).toEqual({ decision: "deny", source: { kind: "unknown" } }); expect(policy.calls).toBe(1);
    expect(await evaluatePermissionPolicy({ decide: async () => "allow" }, req)).toEqual({ decision: "allow", source: { kind: "unknown" } });
  });
  it.each([
    { ...receipt, decision: "deny" }, { decision: "allow", source: { kind: "grant", grantId: "invented" } },
    { ...receipt, unexpected: true }, { decision: "allow", source: { ...receipt.source, rule: { decision: "deny" } } },
    { decision: "allow", source: { kind: "rule", index: 0, rule: { decision: "allow" } } },
  ])("ignores malformed/mismatched receipts without changing the decision", async invalid => {
    const result = await evaluatePermissionPolicy({ decide: async (_req, report) => { report?.(invalid as PermissionPolicyReceipt); return "allow"; } }, req);
    expect(result).toEqual({ decision: "allow", source: { kind: "unknown" } });
  });
  it("refuses ambiguous multiple receipts and ignores late receipt mutation", async () => {
    let late!: (receipt: PermissionPolicyReceipt) => void;
    const result = await evaluatePermissionPolicy({ decide: async (_req, report) => { late = report!; report?.(receipt); report?.(receipt); return "allow"; } }, req);
    expect(result.source).toEqual({ kind: "unknown" }); late(receipt); expect(result.source).toEqual({ kind: "unknown" });
    const missing = await evaluatePermissionPolicy({ decide: async (_req, report) => { late = report!; return "allow"; } }, req);
    late(receipt); expect(missing.source).toEqual({ kind: "unknown" });
  });
  it("clones captured receipts and does not let callback mutations change live rules", async () => {
    const offered = structuredClone(receipt);
    const result = await evaluatePermissionPolicy({ decide: async (_req, report) => { report?.(offered); offered.source = { kind: "unknown" }; return "allow"; } }, req);
    expect(result).toEqual(receipt);
    const policy = new RulePolicy([{ tool: "probe", decision: "allow" }]);
    await policy.decide(req, value => { if (value.source.kind === "rule") value.source.rule.decision = "deny"; });
    expect(await policy.decide(req)).toBe("allow");
  });
});

function live() { const r = new PermissionGrantRegistry(); r.beginRun("session"); return r; }
function grant(r: PermissionGrantRegistry, decision: "allow" | "deny" = "allow") {
  return r.grant({ subject: r.subject, operation: { tool: "probe" }, resource: "*", constraints: {},
    duration: { kind: "session", id: r.context.sessionId! }, delegable: false, decision });
}
it.each(["allow", "deny"] as const)("counts only actual matched %s decisions, not inspection, preview or blocked audits", async decision => {
  const r = live(); const g = grant(r, decision);
  expect(r.decide(req)).toBe(decision); r.list(); r.inspect(); expect(r.inspect()[0]?.matchedDecisions).toBe(0);
  expect(r.authorize(req)).toEqual({ decision: "deny", auditBlocked: true }); expect(r.inspect()[0]?.matchedDecisions).toBe(0);
  await r.flush(async () => {});
  expect(r.authorize(req)).toEqual({ decision, grantId: g.id }); expect(r.inspect()[0]?.matchedDecisions).toBe(1);
  expect(r.authorize({ ...req, origin: "mcp-definition-change" })).toEqual({ decision: "ask" }); expect(r.inspect()[0]?.matchedDecisions).toBe(1);
  const inspect = r.inspect(); inspect[0]!.matchedDecisions = 900; inspect[0]!.grant.operation.tool = "other";
  expect(r.inspect()[0]?.matchedDecisions).toBe(1); r.revoke(g.id); expect(r.inspect()).toEqual([]);
});

it.each(["allow", "deny"] as const)("deny-only consumption does not count an overridden %s as fresh authority", async decision => {
  const r = live(); const g = grant(r, decision); await r.flush(async () => {});
  expect(r.authorize(req, true, "deny-only")).toEqual({ decision, grantId: g.id });
  expect(r.inspect()[0]?.matchedDecisions).toBe(decision === "deny" ? 1 : 0);
});

async function fixture(calls = 1) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-permission-receipts-")); roots.push(root); const store = new SessionStore({ root });
  const id = store.create(); const grants = new PermissionGrantRegistry(); grants.beginSession(id); let executions = 0;
  const tool: AnyTool = { name: "probe", permission: "exec", description: "inert test tool", inputSchema: z.object({}),
    execute: async () => { executions++; return { output: "inert", display: "inert" }; } };
  let remaining = calls;
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(): AsyncIterable<ModelEvent> { if (remaining-- > 0) yield { type: "tool_use", id: `t${remaining}`, name: "probe", input: {} }; yield { type: "stop", reason: remaining >= 0 ? "tool_use" : "end_turn" }; } };
  return { root, store, id, grants, tool, provider, executions: () => executions };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, permissions: PermissionPolicy, extra: Record<string, unknown> = {}) {
  const session = createAgent({ provider: f.provider, tools: [f.tool], store: f.store, permissions, permissionGrants: f.grants, systemPrompt: "inert", ...extra }).run("test", { id: f.id, cwd: f.root });
  for await (const _ of session.events) {} await session.done;
  const events = await f.store.readAll(f.id); for (const event of events) expect(HarnessEvent.safeParse(event).success).toBe(true);
  return events;
}
it("runtime captures actual grant attribution and counts a failed execution as a matched decision", async () => {
  const f = await fixture(); const g = grant(f.grants); f.tool.execute = async () => { throw new Error("inert tool failure"); };
  const events = await run(f, new RulePolicy([]));
  expect(events.filter(e => e.type === "permission.decision")).toEqual([expect.objectContaining({ d: "allow", tool: "probe", toolUseId: "t0", source: { kind: "grant", grantId: g.id } })]);
  expect(f.grants.inspect()[0]?.matchedDecisions).toBe(1); expect(events).toContainEqual(expect.objectContaining({ type: "tool.result", ok: false }));
});
it.each(["allow", "deny"] as const)("explicit base %s retains actual rule attribution and never counts an opposite grant", async decision => {
  const f = await fixture(); grant(f.grants, decision === "allow" ? "deny" : "allow");
  const policy = new RulePolicy([{ decision }]); const spy = vi.spyOn(policy, "decide"); const events = await run(f, policy);
  expect(spy).toHaveBeenCalledTimes(1); expect(f.grants.inspect()[0]?.matchedDecisions).toBe(0);
  expect(events.filter(e => e.type === "permission.decision")[0]).toMatchObject({ d: decision, source: { kind: "rule", index: 1, rule: { decision } } });
});
it("revocation applies before the next decision and attribution does not guess the old grant", async () => {
  const f = await fixture(2); const g = grant(f.grants); let countAtRevoke = 0;
  const events = await run(f, new RulePolicy([]), { hooks: [{ point: "post_tool", handler: () => { countAtRevoke = f.grants.inspect()[0]?.matchedDecisions ?? 0; f.grants.revoke(g.id); return { action: "continue" }; } }], onAsk: async () => "deny" });
  expect(f.executions()).toBe(1); expect(countAtRevoke).toBe(1); expect(f.grants.inspect()).toEqual([]);
  expect(events.filter(e => e.type === "permission.decision").map(e => e.type === "permission.decision" && e.source?.kind)).toEqual(["grant", "fallback", "approval-handler"]);
  expect(events.findIndex(e => e.type === "permission.revoked")).toBeLessThan(events.findIndex(e => e.type === "tool.denied"));
});
it("custom policy is evaluated once at the runtime seam and never mislabeled as a grant or rule", async () => {
  const f = await fixture(); const decide = vi.fn(async (): Promise<Decision> => "allow"); const events = await run(f, { decide });
  expect(decide).toHaveBeenCalledTimes(1); expect(f.executions()).toBe(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "permission.decision", d: "allow", source: { kind: "unknown" } }));
});
