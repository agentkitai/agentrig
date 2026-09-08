import { describe, expect, it } from "vitest";
import { PermissionGrantRegistry, describeShellOperation, type Agent, type PermissionRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.ts";

const req: PermissionRequest = { tool: "bash", class: "exec", cwd: "/workspace", input: { command: "git status --short" }, operation: describeShellOperation("git status --short", "/bin/sh") };
function setup() {
  const grants = new PermissionGrantRegistry();
  const c = new TuiController({ cwd: req.cwd, permissionGrants: grants, agent: {} as Agent });
  return { c, grants };
}

describe("R17d permission friction", () => {
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
    const write: PermissionRequest = { tool: "write_file", class: "write", cwd: req.cwd, input: { path: "src/a" }, paths: ["/workspace/src/a"] };
    const first = c.ask(write); const same = c.ask(write, { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => {}) });
    const other = c.ask({ ...write, paths: ["/workspace/outside/a"] });
    c.startPermissionScope(); c.editPermissionScope(JSON.stringify({ pathPrefix: "/workspace/src" })); c.previewPermissionScope(); c.confirmPermissionScope();
    expect(await first).toBe("allow"); expect(await same).toBe("allow");
    expect(c.snapshot().pending?.req.paths).toEqual(["/workspace/outside/a"]);
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
