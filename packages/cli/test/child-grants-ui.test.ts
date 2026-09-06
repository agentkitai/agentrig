import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, PermissionGrantRegistry, RulePolicy, SessionStore, subagentTool,
  type ModelEvent, type ModelProvider, type AnyTool } from "@agentkitai/agentrig-core";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.ts";

class Stdin extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding(): this { return this; } setRawMode(): this { return this; } ref(): this { return this; } unref(): this { return this; }
  read(): string | null { return this.chunks.shift() ?? null; }
  send(text: string): void { this.chunks.push(text); this.emit("readable"); }
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function provider(calls: string[]): ModelProvider {
  let turn = 0;
  return { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(): AsyncIterable<ModelEvent> {
      const name = calls.shift(); if (name !== undefined) yield { type: "tool_use", id: `${name}-${turn++}`, name, input: name === "subagent" ? { task: "probe" } : {} };
      yield { type: "stop", reason: name === undefined ? "end_turn" : "tool_use" };
    } };
}
it("standing child answers install only child records, while explicit empty runtime context never falls back to root", async () => {
  const root = new PermissionGrantRegistry(); root.beginRun("s"); const child = root.childView();
  const cwd = process.cwd(); const req = { tool: "probe", class: "write" as const, cwd, input: {} };
  root.grant({ subject: root.subject, operation: { tool: "probe" }, resource: "*", constraints: {},
    duration: { kind: "session", id: "s" }, delegable: false, decision: "deny" });
  const c = new TuiController({ cwd, permissionGrants: root, agent: { run() { throw Error("unused"); } } as never });
  const answer = c.ask(req, { permissionGrants: child }); expect(c.snapshot().pending).not.toBeNull();
  c.answerPermission("allow", true); expect(await answer).toBe("allow"); expect(child.list()[0]!.subject).toBe(child.subject);
  expect(root.decide(req)).toBe("deny"); expect(root.childView().decide(req)).toBe("ask");
  const empty = c.ask(req, {}); expect(c.snapshot().pending).not.toBeNull(); c.answerPermission("allow"); expect(await empty).toBe("allow");
  const noStanding = c.ask(req, {}); c.answerPermission("allow", true); expect(await noStanding).toBe("deny");
  expect(root.inspect()).toHaveLength(2);
});
it.each(["ordinary", "protocol"])("%s real spawn→TUI filters root nondelegable grants and keeps new child scopes out of siblings/root", async mode => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-child-ui-")); roots.push(cwd);
  const store = new SessionStore({ root: cwd }); const registry = new PermissionGrantRegistry();
  const c = new TuiController({ cwd, permissionGrants: registry, agent: { run() { throw Error("not attached"); } } as never });
  const stdin = new Stdin(); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 160, rows: 52, isTTY: true, write(text: string) { writes.push(text); return true; } });
  const instance = render(createElement(App, { controller: c }), { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
  const send = (text: string) => stdin.send(mode === "protocol" ? `\u001b[201~${text}` : text);
  const executed: string[] = []; let children = 0;
  const tool: AnyTool = { name: "probe", description: "inert", permission: "write", paths: () => [cwd], inputSchema: z.object({}),
    execute: async (_input, ctx) => { executed.push(ctx.sessionId); return { output: "done", display: "done" }; } };
  const permissions = new RulePolicy([{ tool: "subagent", decision: "allow" }]);
  const spawn = subagentTool({ createAgent, maxDepth: 3, childConfig: () => ({
    provider: provider(children++ === 0 ? ["probe", "probe", "subagent"] : ["probe"]), tools: [tool], permissions,
    permissionGrants: registry, onAsk: c.ask, store, systemPrompt: "child", origin: "subagent",
  }) });
  const agent = createAgent({ provider: provider(["subagent", "subagent", "probe"]), tools: [spawn, tool], permissions,
    permissionGrants: registry, onAsk: c.ask, store, systemPrompt: "root", hooks: [{ point: "user_prompt", handler: async () => {
      registry.grant({ subject: registry.subject, operation: { tool: "probe" }, resource: "*", constraints: {},
        duration: { kind: "session", id: registry.context.sessionId! }, delegable: false, decision: "allow" });
      return { action: "continue" };
    } }] });
  try {
    c.attach(agent); const running = c.submit("spawn probes");
    await vi.waitFor(() => expect(c.snapshot().pending?.req.tool).toBe("probe"));
    const child = c.snapshot().pending!.permissionGrants!;
    expect(child.isChildView).toBe(true); expect(child.subject).not.toBe(registry.subject);
    expect(executed).toEqual([]); // Root nondelegable allow did not reappear through controller.ask.
    send("s"); await vi.waitFor(() => expect(c.snapshot().pending?.scope).toBeDefined());
    send("\r"); await vi.waitFor(() => expect(c.snapshot().pending?.scope?.preview).toBe(true));
    expect(c.snapshot().lines.some(line => line.text.includes('"subject":'+JSON.stringify(child.subject)))).toBe(true);
    send("y");
    // Child's second call and its own grandchild inherit the explicitly confirmed child record.
    await vi.waitFor(() => expect(c.snapshot().pending?.permissionGrants?.subject).not.toBe(child.subject));
    await vi.waitFor(() => expect(c.snapshot().pending?.req.tool).toBe("probe"));
    expect(executed).toHaveLength(3);
    const owned = registry.inspect().find(row => row.grant.subject === child.subject)!;
    expect(owned.matchedDecisions).toBe(2); expect(registry.decide({ tool: "probe", class: "write", input: {}, cwd })).toBe("allow");
    // Remove root's own allow: neither the root nor a sibling may consume the child-owned scope.
    for (const row of registry.inspect().filter(row => row.grant.subject === registry.subject)) registry.revoke(row.grant.id);
    expect(registry.decide({ tool: "probe", class: "write", input: {}, cwd })).toBe("ask");
    expect(c.snapshot().pending!.permissionGrants!.decide({ tool: "probe", class: "write", input: {}, cwd })).toBe("ask");
    send("n"); await vi.waitFor(() => expect(c.snapshot().pending?.permissionGrants?.subject).toBe(registry.subject)); send("n");
    await running; expect(executed).toHaveLength(3); expect(child.active).toBe(false); expect(registry.inspect()).toEqual([]);
    const rootEvents = await store.readAll(c.snapshot().sessionId!);
    expect(rootEvents).toContainEqual(expect.objectContaining({ type: "permission.revoked", grantId: owned.grant.id, subject: child.subject }));
    const spawned = rootEvents.filter(e => e.type === "subagent.spawn");
    if (spawned[0]?.type !== "subagent.spawn") throw Error("no child");
    const childEvents = await store.readAll(spawned[0].id);
    expect(childEvents).toContainEqual(expect.objectContaining({ type: "permission.decision", source: { kind: "grant", grantId: owned.grant.id } }));
    expect(writes.join("")).toContain("Child-owned");
  } finally { await c.shutdown(); instance.unmount(); }
});
