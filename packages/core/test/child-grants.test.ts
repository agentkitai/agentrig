import { expect, it } from "vitest";
import { PermissionGrantRegistry, type PermissionGrantSpec, type PermissionRequest } from "@agentkitai/agentrig-core";
import { bindPermissionView, childPermissionView } from "../src/child-permissions.js";
const req: PermissionRequest = { tool: "probe", class: "exec", input: {}, cwd: process.cwd() };
function record(r: PermissionGrantRegistry, patch: Partial<PermissionGrantSpec> = {}) {
  return r.grant({ subject: r.subject, operation: { tool: "probe" }, resource: "*", constraints: {},
    duration: { kind: "session", id: r.context.sessionId! }, delegable: true, decision: "allow", ...patch });
}
const flush = (r: PermissionGrantRegistry) => r.flush(async () => {});
it.each([false, true])("filters ancestor allows and denies by delegable=%s; keeps own/sibling/root scopes separate", async delegable => {
  for (const decision of ["allow", "deny"] as const) {
    const root = new PermissionGrantRegistry(); root.beginRun("session");
    const inherited = record(root, { delegable, decision }); const child = root.childView(); const sibling = root.childView(); const grandchild = child.childView();
    await flush(root);
    expect(root.decide(req)).toBe(decision);
    // named, and asserted distinct: three views that compare equal would satisfy every predicate
    // below while proving nothing about whose authority is whose
    const views = { child, sibling, grandchild };
    expect(new Set(Object.values(views).map(view => view.subject)).size).toBe(3);
    for (const [name, view] of Object.entries(views)) expect(view.decide(req), name).toBe(delegable ? decision : "ask");
    root.revoke(inherited.id); const local = record(child, { delegable: true }); await flush(child);
    expect(root.inspect().map(x => x.grant.id)).toContain(local.id);
    expect(root.decide(req)).toBe("ask");
    // the sibling is a peer of `child`, not an ancestor of it: a child-owned scope must not reach it
    expect(sibling.subject).not.toBe(child.subject);
    expect(sibling.decide(req), "sibling of the granting child").toBe("ask");
    expect(child.authorize(req)).toEqual({ decision: "allow", grantId: local.id });
    expect(grandchild.authorize(req)).toEqual({ decision: "allow", grantId: local.id });
    expect(root.inspect()[0]!.matchedDecisions).toBe(2);
    expect(() => sibling.revoke(local.id)).toThrow("own grants");
    root.revoke(local.id); await flush(root); expect(grandchild.decide(req)).toBe("ask");
  }
});
it("keeps counters/audit shared, previews pure, and fresh deny selection accurate", async () => {
  const root = new PermissionGrantRegistry(); root.beginRun("s"); const child = root.childView();
  const allow = record(root); const deny = record(root, { decision: "deny" });
  expect(child.authorize(req)).toMatchObject({ auditBlocked: true });
  await expect(child.flush(async () => { throw Error("append unavailable"); })).rejects.toThrow("append unavailable");
  expect(root.authorize(req)).toMatchObject({ auditBlocked: true }); await flush(root);
  expect(child.decide(req)).toBe("allow");
  expect(child.authorize(req, true, "deny-only", true)).toEqual({ decision: "deny", grantId: deny.id });
  expect(root.inspect().map(x => [x.grant.id, x.matchedDecisions])).toEqual([[allow.id, 0], [deny.id, 1]]);
  for (const origin of ["sandbox-escalation", "mcp-definition-change", "external-input-expansion"]) {
    expect(child.decide({ ...req, origin })).toBe("ask"); expect(() => child.remember({ ...req, origin }, "allow")).toThrow("separate consent");
  }
});
it("seals views to the originating task/session and expires child-owned session records", async () => {
  const root = new PermissionGrantRegistry(); const task = root.beginRun("s"); const child = root.childView();
  const own = record(child); const inherited = record(root); await flush(root);
  expect(child.decide(req)).toBe("allow"); root.endRun(task); await flush(root);
  expect(root.inspect().map(x => x.grant.id)).toEqual([inherited.id]);
  expect(root.list().some(g => g.id === own.id)).toBe(false);
  const next = root.beginRun("s"); expect(child.active).toBe(false);
  expect(child.authorize(req)).toEqual({ decision: "deny", viewExpired: true });
  expect(child.inspect()).toEqual([]); expect(() => record(child)).toThrow("expired"); expect(() => child.childView()).toThrow("expired");
  expect(root.childView().decide(req)).toBe("allow"); root.endRun(next); root.beginRun("other"); record(root);
  expect(child.decide(req)).toBe("deny"); expect(() => child.beginRun("s")).toThrow("root grant lifecycle");
});
it("bounds view/subject and grant retention with shared limits, resetting only at root task end", async () => {
  const root = new PermissionGrantRegistry({ maxViews: 2, maxGrants: 1 }); const task = root.beginRun("s");
  const child = root.childView(); const grandchild = child.childView();
  expect(() => root.childView()).toThrow("limit"); expect(() => grandchild.childView()).toThrow("limit");
  record(child); expect(() => record(root)).toThrow("full"); await flush(root); root.endRun(task); await flush(root);
  root.beginRun("s"); expect(root.childView().active).toBe(true);
  expect(() => new PermissionGrantRegistry({ maxViews: 0 })).toThrow("limits");
});
it("derives from exact runtime identity, never copied/stale context or configured root fallback", () => {
  const root = new PermissionGrantRegistry(); const task = root.beginRun("s"); record(root, { delegable: false });
  const ctx = { origin: "root" }; bindPermissionView(ctx, root);
  expect(childPermissionView(ctx, root)!.decide(req)).toBe("ask");
  expect(() => childPermissionView({ ...ctx }, root)).toThrow("unbound");
  const empty = {}; bindPermissionView(empty, undefined); expect(childPermissionView(empty, root)).toBeUndefined();
  root.endRun(task); root.beginRun("s"); expect(() => childPermissionView(ctx, root)).toThrow("context expired");
});
it("failed expiry audit reservation still seals old views and retains changes for explicit recovery", async () => {
  const root = new PermissionGrantRegistry({ maxPending: 2 }); const task = root.beginRun("s"); const child = root.childView();
  record(child); await flush(root); record(child, { operation: { tool: "other" } });
  expect(() => root.endRun(task)).toThrow("audit queue is full");
  expect(child.active).toBe(false); expect(child.authorize(req)).toMatchObject({ viewExpired: true });
  root.beginRun("s"); expect(root.childView().authorize(req)).toMatchObject({ auditBlocked: true });
  expect(root.inspect()).toEqual([]); expect(root.list()).toHaveLength(2); // Still retained for audited recovery, never live.
  await flush(root); expect(root.clear()).toBe(2); await flush(root); expect(root.decide(req)).toBe("ask");
});
it("bounds descendant ancestry independently of the cumulative view cap", () => {
  const root = new PermissionGrantRegistry({ maxViews: 100 }); root.beginRun("s"); let view = root;
  for (let i = 0; i < 64; i++) view = view.childView();
  expect(() => view.childView()).toThrow("limit"); expect(root.childView().active).toBe(true);
});
