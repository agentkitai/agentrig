import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createAgent, PermissionGrantRegistry, SessionStore, describeShellOperation,
  type Agent, type AnyTool, type Decision, type ModelEvent, type ModelProvider,
  type PermissionPolicy, type PermissionRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.ts";

const req: PermissionRequest = { tool: "bash", class: "exec", cwd: resolve("permission-friction-fixture"), input: { command: "git status --short" }, operation: describeShellOperation("git status --short", "/bin/sh") };
function setup() {
  const grants = new PermissionGrantRegistry();
  const c = new TuiController({ cwd: req.cwd, permissionGrants: grants, agent: {} as Agent });
  return { c, grants };
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("R17d permission friction", () => {
  it("direct asks require durable audit and count a consumed grant exactly once", async () => {
    const { c, grants } = setup();
    grants.beginSession("direct");
    grants.remember(req, "allow");
    let resolved = false;
    const pending = c.ask(req, { permissionGrants: grants }).then(d => { resolved = true; return d; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(c.snapshot().pending).not.toBeNull();
    expect(grants.inspect()[0]?.matchedDecisions).toBe(0);
    c.answerPermission("deny"); expect(await pending).toBe("deny");
    await grants.flush(async () => {});
    expect(await c.ask(req, { permissionGrants: grants })).toBe("allow");
    expect(grants.inspect()[0]?.matchedDecisions).toBe(1);
  });

  it("discloses queued request effects before it can be answered during audit", async () => {
    const { c, grants } = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let flushed!: Promise<void>;
    const first = c.ask(req);
    const write: PermissionRequest = { tool: "write_file", class: "write", cwd: req.cwd,
      input: { path: "outside-secret-target" }, paths: [join(req.cwd, "outside-secret-target")] };
    const second = c.ask(write, { permissionGrants: grants,
      flushPermissionGrants: () => { flushed = grants.flush(async () => { await gate; }); return flushed; } });
    c.startDefaultPermissionScope(); c.confirmPermissionScope(); await first;
    try {
      expect(c.snapshot().pending?.req).toBe(write);
      expect(c.snapshot().lines.map(l => l.text).join("\n")).toContain("outside-secret-target");
      c.answerPermission("allow"); expect(await second).toBe("allow");
    } finally {
      release(); await flushed;
      c.answerPermission("deny"); await second;
    }
  });

  it("audit completion cannot dismiss an open scope editor or count its grant", async () => {
    const { c, grants } = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let flushed!: Promise<void>; let resolved = false;
    const first = c.ask(req);
    const second = c.ask(req, { permissionGrants: grants,
      flushPermissionGrants: () => { flushed = grants.flush(async () => { await gate; }); return flushed; }
    }).then(d => { resolved = true; return d; });
    c.startDefaultPermissionScope(); c.confirmPermissionScope(); await first;
    try {
      c.startPermissionScope(); expect(c.snapshot().pending?.scope).toBeDefined();
      release(); await flushed; await Promise.resolve();
      expect(resolved).toBe(false);
      expect(c.snapshot().pending?.scope).toBeDefined();
      expect(grants.inspect()[0]?.matchedDecisions).toBe(0);
    } finally {
      release(); await flushed;
      c.cancelPermissionScope(); c.answerPermission("deny"); await second;
    }
  });

  it("offers the full argv at exact cwd as default, with separate explicit confirmation", async () => {
    const { c, grants } = setup();
    const first = c.ask(req);
    expect(c.snapshot().lines.map(l => l.text).join("\n")).toContain("Enter");
    c.startDefaultPermissionScope();
    expect(c.snapshot().pending?.scope).toMatchObject({ kind: "argv", text: JSON.stringify({ commandPrefix: ["git", "status", "--short"], cwd: req.cwd }), preview: true });
    expect(grants.list()).toEqual([]);
    c.confirmPermissionScope();
    expect(await first).toBe("allow");
    expect(grants.list()).toMatchObject([{ operation: { tool: "bash", commandPrefix: ["git", "status", "--short"] }, constraints: { cwd: req.cwd }, delegable: true }]);
    await grants.flush(async () => {});
    expect(await c.ask(req)).toBe("allow");
    for (const other of [
      { ...req, cwd: "/elsewhere" },
      { ...req, operation: describeShellOperation("git diff", "/bin/sh") },
      { ...req, operation: describeShellOperation("git status --short", "/bin/sh", true) },
    ]) {
      const p = c.ask(other); expect(c.snapshot().pending).not.toBeNull(); c.answerPermission("deny"); expect(await p).toBe("deny");
    }
  });

  it("collapses already queued identical asks only after scoped consent", async () => {
    const { c, grants } = setup();
    const first = c.ask(req); const second = c.ask(req, { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => {}) });
    c.startPermissionScope(); c.previewPermissionScope(); c.confirmPermissionScope();
    expect(await first).toBe("allow");
    expect(await second).toBe("allow");
    expect(c.snapshot().pending).toBeNull();
    expect(grants.inspect()[0]?.matchedDecisions).toBe(1);
    expect(grants.list()).toHaveLength(1);
  });

  it("collapses repeated write asks under an explicit path scope, not other paths", async () => {
    const { c, grants } = setup();
    const write: PermissionRequest = { tool: "write_file", class: "write", cwd: req.cwd, input: { path: "src/a" }, paths: [join(req.cwd, "src/a")] };
    const first = c.ask(write); const same = c.ask(write, { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => {}) });
    const other = c.ask({ ...write, paths: [join(req.cwd, "outside/a")] });
    c.startPermissionScope(); c.editPermissionScope(JSON.stringify({ pathPrefix: join(req.cwd, "src") })); c.previewPermissionScope(); c.confirmPermissionScope();
    expect(await first).toBe("allow"); expect(await same).toBe("allow");
    expect(c.snapshot().pending?.req.paths).toEqual([join(req.cwd, "outside/a")]);
    c.answerPermission("deny"); expect(await other).toBe("deny");
  });

  it("does not coalesce one-time answers or independent security prompts", async () => {
    const { c } = setup();
    const first = c.ask(req); const second = c.ask(req);
    c.answerPermission("allow"); await first;
    expect(c.snapshot().pending).not.toBeNull(); c.answerPermission("deny"); expect(await second).toBe("deny");
    const ordinary = c.ask(req);
    const boundary = c.ask({ ...req, origin: "external-input-expansion" });
    c.startPermissionScope(); c.previewPermissionScope(); c.confirmPermissionScope(); await ordinary;
    expect(c.snapshot().pending?.req.origin).toBe("external-input-expansion");
    c.answerPermission("deny"); expect(await boundary).toBe("deny");
  });

  it.each([
    { ...req, origin: "sandbox-escalation" },
    { ...req, origin: "external-input-expansion" },
    { ...req, origin: "mcp-definition-change" },
    { ...req, operation: undefined },
    { ...req, operation: describeShellOperation("git status", "/bin/sh", true) },
  ])("never defaults unrepresentable or separate-consent requests: %j", async r => {
    const { c, grants } = setup(); const p = c.ask(r);
    c.startDefaultPermissionScope();
    expect(c.snapshot().pending?.scope).toBeUndefined(); expect(grants.list()).toEqual([]);
    c.answerPermission("deny"); expect(await p).toBe("deny");
  });

  it("keeps a queued bash-capable child prompting for a non-delegable parent grant (M2)", async () => {
    const { c, grants } = setup();
    grants.beginRun("test");
    const child = grants.childView(["bash"]);
    const first = c.ask(req);
    let resolved = false;
    const second = c.ask(req, { permissionGrants: child }).then(d => { resolved = true; return d; });
    expect(c.snapshot().queued).toBe(1);
    grants.grant({ subject: grants.subject, operation: { tool: "bash", commandPrefix: ["git", "status", "--short"] },
      resource: "*", constraints: { cwd: req.cwd }, duration: { kind: "session", id: grants.context.sessionId! }, delegable: false, decision: "allow" });
    await grants.flush(async () => {});
    c.answerPermission("allow"); await first;
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(c.snapshot().pending?.permissionGrants).toBe(child);
    c.answerPermission("deny"); expect(await second).toBe("deny");
  });

  it("does not consume an unaudited queued grant, and keeps prompting instead of denying", async () => {
    const { c, grants } = setup();
    const first = c.ask(req);
    let resolved = false;
    const second = c.ask(req).then(d => { resolved = true; return d; });
    c.startDefaultPermissionScope(); c.confirmPermissionScope(); await first;
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(c.snapshot().pending).not.toBeNull();
    expect(grants.inspect()[0]?.matchedDecisions).toBe(0);
    c.answerPermission("deny"); expect(await second).toBe("deny");
  });

  it("counts exactly one consumed queued decision after the audit is durable", async () => {
    const { c, grants } = setup();
    const first = c.ask(req); const second = c.ask(req);
    c.startDefaultPermissionScope();
    // Install the same explicit scope first, then simulate core's durable append.
    grants.grant({ subject: grants.subject, operation: { tool: "bash", commandPrefix: ["git", "status", "--short"] },
      resource: "*", constraints: { cwd: req.cwd }, duration: { kind: "session", id: grants.context.sessionId! }, delegable: true, decision: "allow" });
    await grants.flush(async () => {});
    c.cancelPermissionScope(); c.answerPermission("allow"); await first;
    expect(await second).toBe("allow");
    expect(grants.inspect()[0]?.matchedDecisions).toBe(1);
  });

  it("retains the queued prompt when audit append fails, without counting usage", async () => {
    const { c, grants } = setup();
    const first = c.ask(req);
    let resolved = false;
    const second = c.ask(req, { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => { throw new Error("disk full"); }) }).then(d => { resolved = true; return d; });
    c.startDefaultPermissionScope(); c.confirmPermissionScope(); await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resolved).toBe(false); expect(c.snapshot().pending).not.toBeNull();
    expect(grants.inspect()[0]?.matchedDecisions).toBe(0);
    c.answerPermission("deny"); expect(await second).toBe("deny");
  });

  it("does not consume a queued grant if aborted during its audit append", async () => {
    const { c, grants } = setup(); const abort = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = c.ask(req);
    const second = c.ask(req, { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => { await gate; }) }, abort.signal);
    c.startDefaultPermissionScope(); c.confirmPermissionScope(); await first;
    abort.abort(); expect(await second).toBe("deny"); release();
    await grants.flush(async () => {});
    expect(grants.inspect()[0]?.matchedDecisions).toBe(0);
    expect(c.snapshot().pending).toBeNull();
  });

  it("denies a real ask core issues after the shutdown sweep, and shutdown still joins", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentrig-late-ask-")); roots.push(cwd);
    const grants = new PermissionGrantRegistry();
    const c = new TuiController({ cwd, permissionGrants: grants, agent: { run() { throw new Error("not attached"); } } as never });
    let turns = 0;
    const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
      async *stream(): AsyncIterable<ModelEvent> {
        if (turns++ === 0) { yield { type: "tool_use", id: "t0", name: "probe", input: {} }; yield { type: "stop", reason: "tool_use" }; return; }
        yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" };
      } };
    let executions = 0;
    const tool: AnyTool = { name: "probe", description: "inert test tool", permission: "exec", inputSchema: z.object({}),
      execute: async () => { executions++; return { output: "inert", display: "inert" }; } };
    let reachedPolicy!: () => void; const evaluating = new Promise<void>(r => { reachedPolicy = r; });
    let releasePolicy!: () => void; const held = new Promise<void>(r => { releasePolicy = r; });
    // Core's pre-ask abort check happens before it evaluates the policy and flushes grant audit,
    // and the `onAsk` that follows is not raced against the signal. Holding the policy here puts
    // that ask on the far side of the deny sweep shutdown has already run.
    const permissions: PermissionPolicy = { decide: async () => { reachedPolicy(); await held; return "ask"; } };
    let late!: Promise<Exclude<Decision, "ask">>; let reachedAsk!: () => void;
    const asked = new Promise<void>(r => { reachedAsk = r; });
    c.attach(createAgent({ provider, tools: [tool], permissions, permissionGrants: grants, store: new SessionStore({ root: join(cwd, "logs") }),
      systemPrompt: "inert", repoMap: false, onAsk: (request, context) => { late = c.ask(request, context); reachedAsk(); return late; } }));
    const running = c.submit("probe once");
    await evaluating;
    expect(c.snapshot().pending).toBeNull();
    let closed = false; const shutdown = c.shutdown().then(() => { closed = true; });
    expect(closed).toBe(false);
    releasePolicy(); await asked;
    expect(c.snapshot().pending).toBeNull();
    expect(c.snapshot().queued).toBe(0);
    expect(await late).toBe("deny");
    await shutdown; await running;
    expect(closed).toBe(true); expect(executions).toBe(0);
  });

  it("refuses a late direct ask while closing and once closed, consuming no standing grant", async () => {
    const { c } = setup();
    const standing = new PermissionGrantRegistry(); standing.beginSession("late-ask");
    standing.remember(req, "allow"); await standing.flush(async () => {});
    expect(await c.ask(req, { permissionGrants: standing })).toBe("allow");
    expect(standing.inspect()[0]?.matchedDecisions).toBe(1);
    let ready!: () => void; const entered = new Promise<void>(r => { ready = r; });
    let finish!: () => void; const working = new Promise<void>(r => { finish = r; });
    c.setManualCommands({ doctor: async () => { ready(); await working; return []; }, diff: async () => [] });
    const doctor = c.submit("/doctor"); await entered;
    let closed = false; const shutdown = c.shutdown().then(() => { closed = true; });
    const closing = c.ask(req, { permissionGrants: standing });
    expect(c.snapshot().pending).toBeNull();
    expect(standing.inspect()[0]?.matchedDecisions).toBe(1);
    expect(await closing).toBe("deny");
    expect(closed).toBe(false);
    finish(); await shutdown; await doctor;
    const fresh = new PermissionGrantRegistry();
    const late = c.ask(req, { permissionGrants: fresh });
    expect(fresh.context.sessionId).toBeUndefined();
    expect(c.snapshot().pending).toBeNull();
    expect(await late).toBe("deny");
    expect(fresh.list()).toEqual([]); expect(standing.inspect()[0]?.matchedDecisions).toBe(1);
  });

  it("does not collapse across parent and child registries or after abort", async () => {
    const { c, grants } = setup();
    grants.beginRun("test");
    const child = grants.childView(["read_file"]);
    const first = c.ask(req); const second = c.ask(req, { permissionGrants: child });
    c.startPermissionScope(); c.previewPermissionScope(); c.confirmPermissionScope(); await first;
    expect(c.snapshot().pending).toBeNull(); expect(await second).toBe("deny");
    grants.clear();
    const ordinary = c.ask(req); const abort = new AbortController(); const queued = c.ask(req, undefined, abort.signal);
    abort.abort(); expect(await queued).toBe("deny");
    c.startPermissionScope(); c.previewPermissionScope(); c.confirmPermissionScope(); await ordinary;
    expect(c.snapshot().pending).toBeNull();
  });
});
