import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeShellOperation, PermissionGrantRegistry, permissionGrantCoversRequest, type PermissionRequest } from "@agentkitai/agentrig-core";
import { initialPermissionScope, MAX_SCOPE_TEXT, permissionEffectLines, proposedPermissionGrant } from "../src/tui/permission-prompt.ts";
import { TuiController } from "../src/tui/controller.ts";

const cwd = resolve("/scope-test");
const request = (patch: Partial<PermissionRequest> = {}): PermissionRequest => ({ tool: "get_safe", class: "write", input: {}, cwd, paths: ["src/a", "src/b"], ...patch });
function registry(): PermissionGrantRegistry { const r = new PermissionGrantRegistry(); r.beginRun("session"); return r; }
function controller(): TuiController { return new TuiController({ cwd, agent: { run() { throw Error("unused"); } } as never }); }

describe("honest effect summaries", () => {
  it("shows every declared path and unknowns, without deriving read-only/network authority from names or prose", () => {
    const text = permissionEffectLines(request({ input: { readOnlyHint: true, effect: "safe" } })).join("\n");
    expect(text).toContain('"src/a"'); expect(text).toContain('"src/b"'); expect(text).toContain("may change");
    expect(text).toContain("MCP read-only hints do not establish"); expect(text).toContain("any resource/class/cwd");
    const read = permissionEffectLines(request({ class: "read", paths: [] })).join("\n");
    expect(read).toContain("not proof of read-only"); expect(read).toContain("path effects unknown");
  });
  it("renders shell argv literally without claiming known effects or network absence", () => {
    const text = permissionEffectLines(request({ class: "exec", paths: undefined, operation: describeShellOperation("git status", "/bin/sh") })).join("\n");
    expect(text).toContain('Literal argv: ["git","status"]'); expect(text).toContain("may change files and reach the network");
  });
  it("escapes terminal controls and bounds a large declared-path summary explicitly", () => {
    const text = permissionEffectLines(request({ tool: "get\u001b[2J", paths: Array.from({ length: 128 }, () => "x".repeat(4096)) })).join("\n");
    expect(text).not.toContain("\u001b"); expect(text).toContain("omitted from summary"); expect(text.length).toBeLessThan(18000);
  });
});

describe("validated scoped proposals", () => {
  it("creates no authority during preview and shares the runtime all-path matcher", () => {
    const r = registry(); const req = request();
    const spec = proposedPermissionGrant(req, "path", JSON.stringify({ pathPrefix: join(cwd, "src") }), r);
    expect(r.list()).toEqual([]); expect(r.decide(req)).toBe("ask");
    expect(permissionGrantCoversRequest(spec, req)).toBe(true);
    expect(permissionGrantCoversRequest(spec, request({ paths: ["src/a", "outside"] }))).toBe(false);
    r.grant(spec); expect(r.decide(req)).toBe("allow"); expect(r.decide(request({ paths: ["src-other/a"] }))).toBe("ask");
    expect(spec.constraints).toEqual({ cwd }); expect(spec.duration).toEqual({ kind: "session", id: "session" });
  });
  it("rejects a scope missing even one current path instead of granting the current request anyway", () => {
    const r = registry();
    expect(() => proposedPermissionGrant(request(), "path", JSON.stringify({ pathPrefix: join(cwd, "src/a") }), r)).toThrow("does not cover");
    expect(r.list()).toEqual([]);
  });
  it.each([undefined, [], Array.from({ length: 129 }, () => "src/a")])("refuses absent/empty/overlarge path sets", paths => {
    expect(() => initialPermissionScope(request({ paths }))).toThrow("declared paths");
  });
  it.each(["{}", '{"pathPrefix":"relative"}', '{"pathPrefix":"*"}', JSON.stringify({ pathPrefix: cwd, decision: "allow" }), "x".repeat(MAX_SCOPE_TEXT + 1)])("refuses malformed, widened-key or oversized edits", text => {
    expect(() => proposedPermissionGrant(request(), "path", text, registry())).toThrow();
  });
  it("requires literal argv prefix and exact cwd, never shell substring matching", () => {
    const r = registry(); const req = request({ class: "exec", paths: undefined, operation: describeShellOperation("git status", "/bin/sh") });
    const draft = JSON.stringify({ commandPrefix: ["git"], cwd });
    const spec = proposedPermissionGrant(req, "argv", draft, r); expect(r.list()).toEqual([]); r.grant(spec);
    expect(r.decide(req)).toBe("allow");
    for (const command of ["rm -rf /", "git status; printf x", "git $(printf status)", "git status | cat"]) {
      expect(r.decide({ ...req, operation: describeShellOperation(command, "/bin/sh") })).toBe("ask");
    }
    expect(() => proposedPermissionGrant(req, "argv", JSON.stringify({ commandPrefix: ["git", "diff"], cwd }), r)).toThrow("does not cover");
    expect(() => proposedPermissionGrant(req, "argv", JSON.stringify({ commandPrefix: ["git"], cwd: join(cwd, "other") }), r)).toThrow("does not cover");
  });
  it.each([describeShellOperation("git status; printf x", "/bin/sh"), describeShellOperation("git status", "cmd.exe"), describeShellOperation("git status", "/bin/sh", true)])("never substitutes a path scope for an unsupported/background shell", operation => {
    expect(() => initialPermissionScope(request({ operation }))).toThrow("foreground literal");
  });
  it.each(["sandbox-escalation", "mcp-definition-change"])("never remembers separate %s consent", async origin => {
    const c = controller(); const promise = c.ask(request({ origin })); c.startPermissionScope();
    expect(c.snapshot().pending?.scope).toBeUndefined(); c.answerPermission("deny"); expect(await promise).toBe("deny"); expect(c.permissionGrants.list()).toEqual([]);
  });
});

describe("controller scope lifecycle", () => {
  it("displays queued request effects only when that request becomes active", async () => {
    const c = controller(); const first = c.ask(request({ tool: "first" })); const second = c.ask(request({ tool: "second" }));
    expect(c.snapshot().lines.some(l => l.text.includes('for "first"'))).toBe(true);
    expect(c.snapshot().lines.some(l => l.text.includes('for "second"'))).toBe(false);
    c.answerPermission("deny"); expect(await first).toBe("deny");
    expect(c.snapshot().lines.some(l => l.text.includes('for "second"'))).toBe(true);
    c.answerPermission("deny"); expect(await second).toBe("deny");
  });
  it("requires preview then explicit confirmation and checks again at installation", async () => {
    const c = controller(); const answer = c.ask(request()); c.startPermissionScope();
    c.confirmPermissionScope(); expect(c.permissionGrants.list()).toEqual([]);
    c.editPermissionScope(JSON.stringify({ pathPrefix: join(cwd, "src/a") })); c.previewPermissionScope();
    expect(c.snapshot().pending?.scope?.error).toContain("does not cover"); c.confirmPermissionScope(); expect(c.permissionGrants.list()).toEqual([]);
    c.editPermissionScope(JSON.stringify({ pathPrefix: join(cwd, "src") })); c.previewPermissionScope();
    expect(c.snapshot().lines.some(l => l.text.includes("NOT installed"))).toBe(true); expect(c.permissionGrants.list()).toEqual([]);
    c.confirmPermissionScope(); expect(await answer).toBe("allow"); expect(c.permissionGrants.list()).toHaveLength(1);
  });
  it("editing invalidates a prior preview; cancelled scope leaves current request unanswered", async () => {
    const c = controller(); const answer = c.ask(request()); c.startPermissionScope(); c.previewPermissionScope();
    c.editPermissionScope("{}"); c.confirmPermissionScope(); expect(c.permissionGrants.list()).toEqual([]);
    c.cancelPermissionScope(); expect(c.snapshot().pending).not.toBeNull(); c.answerPermission("deny"); expect(await answer).toBe("deny");
  });
  it("refuses a preview after registry reset, retaining no authority", async () => {
    const c = controller(); const answer = c.ask(request()); c.startPermissionScope(); c.previewPermissionScope();
    c.permissionGrants.clear(); c.confirmPermissionScope(); expect(await answer).toBe("deny"); expect(c.permissionGrants.list()).toEqual([]);
  });
});
