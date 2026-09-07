import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { describeShellOperation, resolveShell, SessionStore, type ModelEvent, type PermissionRequest } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.ts";
import { waitForTuiState } from "./tui-readiness.ts";

class Stdin extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding(): this { return this; } setRawMode(): this { return this; }
  ref(): this { return this; } unref(): this { return this; }
  read(): string | null { return this.chunks.shift() ?? null; }
  send(...chunks: string[]): void { this.chunks.push(...chunks); this.emit("readable"); }
}
const roots: string[] = []; const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function mount() {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-scope-ui-")); roots.push(cwd);
  const controller = new TuiController({ cwd, agent: { run() { throw Error("not attached"); } } as never });
  const stdin = new Stdin(); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 160, rows: 52, isTTY: true, write(s: string) { writes.push(s); return true; } });
  const instance = render(createElement(App, { controller }), { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(async () => { await controller.shutdown(); instance.unmount(); });
  await new Promise(r => setTimeout(r, 100));
  return { cwd, controller, stdin, writes };
}
const shell = resolveShell();
it.skipIf(describeShellOperation("printf x", shell.path).status !== "parsed").each([
  { mode: "ordinary", delayedThirdCall: false }, { mode: "protocol", delayedThirdCall: false },
  { mode: "ordinary", delayedThirdCall: true }, { mode: "protocol", delayedThirdCall: true },
])("$mode input creates an audited narrow grant in the actual CLI/runtime and refuses the next outside command (delayed=$delayedThirdCall)", async ({ mode, delayedThirdCall }) => {
  const h = await mount(); vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key"); let asks = 0;
  const built = await buildAgent({ root: h.cwd, provider: "anthropic", model: "fake", shell: shell.path, maxTurns: "5", maxTokensPerTurn: "100" }, {
    permissionGrants: h.controller.permissionGrants, onAsk: req => { asks++; return h.controller.ask(req); },
  });
  const commands = ["printf '%s' first", "printf '%s' 'second; literal'", "printf '%s' third; printf '%s' outside"];
  vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    // A supported asynchronous provider can reach the next approval after the old
    // 1s polling budget. Both real authorized shell calls have completed by here.
    if (delayedThirdCall && commands.length === 1) await new Promise(resolve => setTimeout(resolve, 1100));
    const command = commands.shift(); if (command !== undefined) yield { type: "tool_use", id: `t${commands.length}`, name: "bash", input: { command } };
    yield { type: "stop", reason: command === undefined ? "end_turn" : "tool_use" };
  });
  h.controller.attach(built.agent); const run = h.controller.submit("exercise scoped approval");
  await waitForTuiState(h.controller, run, "initial scoped shell approval", state =>
    state.pending?.req.tool === "bash" && (state.pending.req.input as { command?: unknown }).command === "printf '%s' first");
  const send = (text: string) => h.stdin.send(mode === "protocol" ? `\u001b[201~${text}` : text);
  send("s"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope).toBeDefined());
  const old = h.controller.snapshot().pending!.scope!.text;
  h.stdin.send(...Array.from(old, () => mode === "protocol" ? "\u001b[201~\u007f" : "\u007f"));
  await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.text).toBe(""));
  const text = JSON.stringify({ commandPrefix: ["printf", "%s"], cwd: h.cwd }); send(text);
  await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.text).toBe(text));
  send("\r"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.preview).toBe(true));
  await vi.waitFor(() => expect(h.writes.join("")).toContain("NOT installed"));
  expect(h.controller.snapshot().lines.some(l => l.text.includes('"commandPrefix":["printf","%s"]') && l.text.includes(`"cwd":${JSON.stringify(h.cwd)}`) && l.text.includes('"resource":"*"'))).toBe(true);
  expect(h.writes.join("")).toContain('"commandPrefix":["printf","%s"]');
  expect(h.controller.permissionGrants.list()).toEqual([]); expect(asks).toBe(1);
  send("y");
  await waitForTuiState(h.controller, run, "outside command after two scoped shell executions", state =>
    state.pending?.req.tool === "bash" && state.pending.req.operation?.status === "unsupported" &&
    (state.pending.req.input as { command?: unknown }).command === "printf '%s' third; printf '%s' outside");
  expect(asks).toBe(2);
  expect(h.controller.permissionGrants.list()[0]?.operation.commandPrefix).toEqual(["printf", "%s"]);
  expect(h.controller.snapshot().pending?.req.operation?.status).toBe("unsupported"); send("n"); await run;
  expect(h.controller.snapshot().lines.some(l => l.text.includes("first"))).toBe(true);
  expect(h.controller.snapshot().lines.some(l => l.text.includes("second; literal"))).toBe(true);
  expect(h.controller.snapshot().lines.some(l => l.text.includes("effects are not established by argv"))).toBe(true);
  const events = await new SessionStore({ root: h.cwd }).readAll(h.controller.snapshot().sessionId!);
  expect(events.filter(e => e.type === "tool.result").map(e => e.type === "tool.result" && e.display)).toEqual(["first", "second; literal"]);
  expect(events.findIndex(e => e.type === "permission.granted")).toBeLessThan(events.findIndex(e => e.type === "tool.call"));
  expect(events.filter(e => e.type === "tool.denied")).toHaveLength(1);
}, 10_000);

it.each(["ordinary", "protocol"])("%s keys retain y/a/n/d and reject scoped separate consent", async mode => {
  const h = await mount(); const req: PermissionRequest = { tool: "file_tool", class: "write", input: {}, cwd: h.cwd, paths: ["a"] };
  const send = (s: string) => h.stdin.send(mode === "protocol" ? `\u001b[201~${s}` : s);
  for (const [key, decision, standing] of [["y", "allow", false], ["a", "allow", true], ["n", "deny", false], ["d", "deny", true]] as const) {
    h.controller.permissionGrants.clear(); const answer = h.controller.ask(req); send(key);
    expect(await answer).toBe(decision); expect(h.controller.permissionGrants.list()).toHaveLength(standing ? 1 : 0);
  }
  for (const origin of ["sandbox-escalation", "mcp-definition-change", "external-input-expansion"]) {
    h.controller.permissionGrants.clear(); const answer = h.controller.ask({ ...req, origin }); send("s");
    await vi.waitFor(() => expect(h.controller.snapshot().lines.some(l => l.text.includes("separate consent"))).toBe(true));
    expect(h.controller.snapshot().pending?.scope).toBeUndefined(); send("n"); expect(await answer).toBe("deny"); expect(h.controller.permissionGrants.list()).toEqual([]);
  }
});

it.each(["ordinary", "protocol"])("%s external expansion rejects standing keys and grants, requires a fresh answer, and retains child provenance", async mode => {
  const h = await mount();
  const req: PermissionRequest = { tool: "exec", class: "exec", input: {}, cwd: h.cwd };
  h.controller.permissionGrants.beginSession("fixture");
  h.controller.permissionGrants.remember(req, "allow");
  const send = (text: string) => h.stdin.send(mode === "protocol" ? `\u001b[201~${text}` : text);
  const answer = h.controller.ask({ ...req, origin: "external-input-expansion", sourceOrigin: "child:fixture", expansionSurface: "exec" });
  expect(h.controller.snapshot().pending).not.toBeNull();
  for (const key of ["a", "d", "s"]) {
    send(key); await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.controller.snapshot().pending).not.toBeNull();
    expect(h.controller.snapshot().pending?.scope).toBeUndefined();
    expect(h.controller.permissionGrants.list()).toHaveLength(1);
  }
  expect(h.controller.snapshot().lines.some(line => line.text.includes("child:fixture") && line.text.includes("Fresh approval"))).toBe(true);
  send("y"); expect(await answer).toBe("allow");
  const again = h.controller.ask({ ...req, origin: "external-input-expansion", expansionSurface: "exec" });
  expect(h.controller.snapshot().pending).not.toBeNull(); send("n"); expect(await again).toBe("deny");
  expect(h.controller.permissionGrants.list()).toHaveLength(1);
});

it("framed paste cannot enter or confirm scoped approval, and same-chunk preview+yes cannot grant", async () => {
  const h = await mount(); const answer = h.controller.ask({ tool: "write_file", class: "write", input: {}, cwd: h.cwd, paths: ["a"] });
  h.stdin.send("\u001b[200~s\r y\u001b[201~"); await new Promise(r => setTimeout(r, 100));
  expect(h.controller.snapshot().pending?.scope).toBeUndefined();
  h.stdin.send("s"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope).toBeDefined());
  h.stdin.send("\u001b[201~\ry"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.preview).toBe(true));
  expect(h.controller.permissionGrants.list()).toEqual([]);
  h.stdin.send("\u001b[200~y\u001b[201~"); await new Promise(r => setTimeout(r, 100)); expect(h.controller.permissionGrants.list()).toEqual([]);
  h.stdin.send("n"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope).toBeUndefined());
  h.stdin.send("n"); expect(await answer).toBe("deny");
});

it("a rejected path scope never dispatches the current real file write; confirmed scope constrains later writes", async () => {
  const h = await mount(); vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key"); let asks = 0;
  const built = await buildAgent({ root: h.cwd, provider: "anthropic", model: "fake", maxTurns: "5", maxTokensPerTurn: "100", deny: [], allow: [] }, {
    permissionGrants: h.controller.permissionGrants, onAsk: req => { asks++; return h.controller.ask(req); },
  });
  const paths = ["sub/a", "sub/b", "outside"];
  vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    const path = paths.shift(); if (path !== undefined) yield { type: "tool_use", id: `t${paths.length}`, name: "write_file", input: { path, content: path } };
    yield { type: "stop", reason: path === undefined ? "end_turn" : "tool_use" };
  });
  h.controller.attach(built.agent); const run = h.controller.submit("write within scope");
  await vi.waitFor(() => expect(h.controller.snapshot().pending).not.toBeNull());
  h.stdin.send("s"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope).toBeDefined());
  h.controller.editPermissionScope(JSON.stringify({ pathPrefix: join(h.cwd, "elsewhere") })); h.stdin.send("\r");
  await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.error).toContain("does not cover"));
  h.controller.confirmPermissionScope(); expect(h.controller.permissionGrants.list()).toEqual([]);
  await expect(readFile(join(h.cwd, "sub/a"), "utf8")).rejects.toThrow();
  h.controller.editPermissionScope(JSON.stringify({ pathPrefix: join(h.cwd, "sub") })); h.stdin.send("\r");
  await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.preview).toBe(true)); h.stdin.send("y");
  await vi.waitFor(() => expect(asks).toBe(2)); h.stdin.send("n"); await run;
  expect(await readFile(join(h.cwd, "sub/a"), "utf8")).toBe("sub/a");
  expect(await readFile(join(h.cwd, "sub/b"), "utf8")).toBe("sub/b");
  await expect(readFile(join(h.cwd, "outside"), "utf8")).rejects.toThrow();
});

it("a previous preview cannot authorize a changed preview from the same protocol chunk", async () => {
  const h = await mount(); const answer = h.controller.ask({ tool: "write_file", class: "write", input: {}, cwd: h.cwd, paths: ["sub/a"] });
  h.stdin.send("s"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope).toBeDefined());
  h.stdin.send("\r"); await vi.waitFor(() => expect(h.controller.snapshot().pending?.scope?.preview).toBe(true));
  const previous = h.controller.snapshot().pending!.scope!.text;
  const changed = JSON.stringify({ pathPrefix: join(h.cwd, "sub") });
  h.stdin.send(`\u001b[201~e${"\u007f".repeat(previous.length)}${changed}\ry`);
  await new Promise(r => setTimeout(r, 100));
  expect(h.controller.permissionGrants.list()).toEqual([]);
  expect(h.controller.snapshot().pending?.scope?.text).toBe(changed);
  expect(h.controller.snapshot().pending?.scope?.preview).toBe(true);
  h.stdin.send("y"); expect(await answer).toBe("allow");
  expect(h.controller.permissionGrants.list()[0]?.resource).toEqual({ kind: "path-prefix", path: join(h.cwd, "sub") });
});
