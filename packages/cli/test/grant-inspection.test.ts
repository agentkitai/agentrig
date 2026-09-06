import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { describeShellOperation, HarnessEvent, resolveShell, SessionStore, type ModelEvent, type PermissionDecisionSource } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.ts";
import { App } from "../src/tui/app.tsx";
import { buildAgent } from "../src/agent-builder.ts";
import { renderChatEvent, renderEvent } from "../src/render.ts";
import { waitForTuiState } from "./tui-readiness.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function controller(cwd = process.cwd()) { return new TuiController({ cwd, agent: { run() { throw Error("unused"); } } as never }); }
it("lists exact live scope/duration, age and matched counts, and only revokes an exact id", async () => {
  const c = controller(); const r = c.permissionGrants; r.beginSession("session"); vi.spyOn(Date, "now").mockReturnValue(100000);
  const grant = r.grant({ subject: r.subject, operation: { tool: "write_file", class: "write" }, resource: { kind: "path-prefix", path: process.cwd() },
    constraints: { cwd: process.cwd() }, duration: { kind: "session", id: "session" }, delegable: false, decision: "deny" });
  vi.mocked(Date.now).mockReturnValue(112000);
  await c.submit("/permissions"); const text = c.snapshot().lines.at(-1)!.text;
  expect(text).toContain(grant.id); expect(text).toContain("age=12s matched-decisions=0");
  expect(text).toContain('"resource":{"kind":"path-prefix"'); expect(text).toContain('"duration":{"kind":"session","id":"session"}');
  expect(text).toContain("not executions"); expect(text).toContain("only delegable ancestor grants");
  await c.submit(`/permissions revoke ${grant.id.slice(0, 8)}`); expect(r.list()).toHaveLength(1);
  await c.submit("/permissions reset extra"); expect(r.list()).toHaveLength(1); expect(c.snapshot().lines.at(-1)?.text).toContain("usage:");
  await c.submit(`/permissions revoke ${grant.id}`); expect(r.inspect()).toEqual([]); expect(c.snapshot().lines.at(-1)?.text).toContain("revoked grant");
});
it.each([
  [{ kind: "rule", index: 2, rule: { tool: "bash", decision: "allow" } }, "rule #2"],
  [{ kind: "grant", grantId: "grant-id" }, "grant grant-id"],
  [{ kind: "unknown" }, "attribution unknown"],
  [{ kind: "fallback" }, "policy fallback"],
  [{ kind: "approval-handler" }, "approval handler (human/host)"],
  [{ kind: "unattended" }, "unattended deny"],
  [{ kind: "boundary", reason: "external-input-expansion" }, "external-input-expansion"],
] as const)("renders source %j with the correlated decision", (source, expected) => {
  const event = HarnessEvent.parse({ type: "permission.decision", d: source.kind === "unattended" ? "deny" : "allow", tool: "bash", toolUseId: "actual-call", source: source as PermissionDecisionSource, seq: 1, ts: 1, sessionId: "s" });
  expect(renderEvent(event)).toContain(expected); expect(renderChatEvent(event)).toContain(expected); expect(renderChatEvent(event)).toContain('"actual-call"');
});
it("keeps legacy permission events compatible without inventing attribution", () => {
  const event = HarnessEvent.parse({ type: "permission.decision", d: "allow", seq: 1, ts: 1, sessionId: "s" });
  expect(renderChatEvent(event)).toBeNull(); expect(renderEvent(event)).not.toContain("rule");
});

class Stdin extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding(): this { return this; } setRawMode(): this { return this; } ref(): this { return this; } unref(): this { return this; }
  read(): string | null { return this.chunks.shift() ?? null; }
  send(...chunks: string[]): void { this.chunks.push(...chunks); this.emit("readable"); }
}
const shell = resolveShell();
it.skipIf(describeShellOperation("printf x", shell.path).status !== "parsed").each([0, 1200])("real TUI inspection/revocation sees counted grants and changes the next runtime decision (provider delay %ims)", async providerDelay => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-grant-inspect-")); roots.push(root); vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key");
  const c = controller(root); const stdin = new Stdin(); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 160, rows: 52, isTTY: true, write(text: string) { writes.push(text); stdout.emit("frame"); return true; } });
  const frames = { snapshot: () => c.snapshot(), subscribe(listener: (state: ReturnType<TuiController["snapshot"]>) => void) {
    const changed = () => listener(c.snapshot()); stdout.on("frame", changed); changed();
    return () => { stdout.off("frame", changed); };
  } };
  const instance = render(createElement(App, { controller: c }), { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let asks = 0;
  try {
    const built = await buildAgent({ root, provider: "anthropic", model: "fake", shell: shell.path, maxTurns: "5", maxTokensPerTurn: "100" }, {
      permissionGrants: c.permissionGrants, onAsk: req => { asks++; return c.ask(req); },
    });
    let turn = 0;
    vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
      const index = turn++; if (index === 2) { await new Promise(r => setTimeout(r, providerDelay)); await barrier; }
      if (index < 3) yield { type: "tool_use", id: `t${index}`, name: "bash", input: { command: `printf '%s' '${index}'` } };
      yield { type: "stop", reason: index < 3 ? "tool_use" : "end_turn" };
    });
    c.attach(built.agent); const run = c.submit("inspect grants");
    await waitForTuiState(c, run, "first shell approval", state => state.pending?.req.tool === "bash");
    await waitForTuiState(frames, run, "visible shell approval", () => writes.join("").includes('allow "bash"'));
    stdin.send("s");
    await waitForTuiState(c, run, "shell scope editor", state => state.pending?.scope !== undefined);
    c.editPermissionScope(JSON.stringify({ commandPrefix: ["printf", "%s"], cwd: root })); stdin.send("\r");
    await waitForTuiState(c, run, "shell scope preview", state => state.pending?.scope?.preview === true);
    await waitForTuiState(frames, run, "visible exact scope preview", () => writes.join("").includes("Exact future scope printed above"));
    expect(c.permissionGrants.inspect()).toEqual([]);
    stdin.send("y");
    // Controller turns counts completed turns. The next request starts after both dispatches;
    // provider entry speed is not the contract, and the barrier still prevents the third tool.
    await waitForTuiState(c, run, "third request after two completed turns", state =>
      state.turns === 2 && state.activity?.kind === "thinking" && state.pending === null);
    const record = c.permissionGrants.inspect()[0]!; expect(record.matchedDecisions).toBe(1); expect(asks).toBe(1);
    await waitForTuiState(frames, run, "visible matched grant", () => writes.join("").includes(`grant ${record.grant.id}`));
    stdin.send("/permissions", "\r");
    await waitForTuiState(c, run, "grant inspection result", state => state.lines.at(-1)?.text.includes("matched-decisions=1") === true);
    expect(c.permissionGrants.inspect()[0]?.matchedDecisions).toBe(1);
    stdin.send(`/permissions revoke ${record.grant.id}`, "\r");
    await waitForTuiState(c, run, "exact grant revocation", () => c.permissionGrants.inspect().length === 0);
    expect(c.permissionGrants.inspect()).toEqual([]);
    release(); await waitForTuiState(c, run, "new shell ask after revocation", state => state.pending?.req.tool === "bash" && asks === 2);
    stdin.send("n"); await run;
    const events = await new SessionStore({ root }).readAll(c.snapshot().sessionId!);
    expect(events.filter(e => e.type === "tool.result").map(e => e.type === "tool.result" && e.display)).toEqual(["0", "1"]);
    expect(events.filter(e => e.type === "permission.decision" && e.d === "allow").map(e => e.type === "permission.decision" && e.source?.kind)).toEqual(["approval-handler", "grant"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "permission.revoked", grantId: record.grant.id }));
    expect(events).toContainEqual(expect.objectContaining({ type: "permission.decision", toolUseId: "t2", d: "deny", source: { kind: "approval-handler" } }));
  } finally { release(); await c.shutdown(); instance.unmount(); }
}, 20_000);
