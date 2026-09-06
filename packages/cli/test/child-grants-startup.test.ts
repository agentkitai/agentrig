import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, resolveShell, describeShellOperation, type ModelEvent } from "@agentkitai/agentrig-core";
import type { TuiController } from "../src/tui/controller.ts";
const harness = vi.hoisted(() => ({ exercise: undefined as undefined | ((c: TuiController) => Promise<void>) }));
// Substitute terminal mounting only. startTui, buildAgent, subagentOptions, runtime, controller
// and storage are real. Existing Ink tests separately exercise both keyboard input paths.
vi.mock("ink", async importOriginal => ({ ...await importOriginal<typeof import("ink")>(), render: (element: { props: { controller: TuiController } }) => ({
  unmount() {}, waitUntilExit: () => harness.exercise!(element.props.controller),
}) }));
vi.mock("../src/agent-builder.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/agent-builder.js")>();
  return { ...original, buildAgent: async (...args: Parameters<typeof original.buildAgent>) => {
    const built = await original.buildAgent(...args); const registry = args[1]!.permissionGrants!;
    const begin = registry.beginRun.bind(registry);
    vi.spyOn(registry, "beginRun").mockImplementation(id => {
      const task = begin(id); registry.grant({ subject: registry.subject, operation: { tool: "bash" }, resource: "*", constraints: {},
        duration: { kind: "session", id }, delegable: false, decision: "allow" }); return task;
    });
    let parentTurns = 0; let childTurns = 0;
    for (const provider of new Set([built.provider, built.providers.subagents])) vi.spyOn(provider, "stream").mockImplementation(async function* (request): AsyncIterable<ModelEvent> {
      const child = JSON.stringify(request.messages[0]).includes("R12d child startup probe");
      const first = child ? childTurns++ === 0 : parentTurns++ === 0;
      if (first) yield child ? { type: "tool_use", id: "child-bash", name: "bash", input: { command: "printf child" } }
        : { type: "tool_use", id: "spawn", name: "subagent", input: { task: "R12d child startup probe" } };
      yield { type: "stop", reason: first ? "tool_use" : "end_turn" };
    });
    return built;
  } };
});
import { startTui } from "../src/tui/start.tsx";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const shell = resolveShell();
it.skipIf(describeShellOperation("printf child", shell.path).status !== "parsed").each([false, true])("production startTui forwards child context through actual builder/spawn (standing=%s)", async standing => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-child-start-")); roots.push(root); vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture");
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  harness.exercise = async c => {
    const run = c.submit("R12d root startup probe");
    await vi.waitFor(() => expect(c.snapshot().pending?.req.tool).toBe("bash"));
    const child = c.snapshot().pending!.permissionGrants!;
    expect(child.isChildView).toBe(true); expect(child.subject).not.toBe(c.permissionGrants.subject);
    c.answerPermission(standing ? "allow" : "deny", standing); await run;
    expect(child.active).toBe(false); expect(c.permissionGrants.list().every(g => g.subject === c.permissionGrants.subject)).toBe(true);
    const store = new SessionStore({ root }); const events = await store.readAll(c.snapshot().sessionId!);
    const spawn = events.find(e => e.type === "subagent.spawn"); if (spawn?.type !== "subagent.spawn") throw Error("no actual child");
    const childEvents = await store.readAll(spawn.id);
    expect(childEvents.some(e => e.type === "tool.result" && e.id === "child-bash" && e.ok && e.display === "child")).toBe(standing);
    if (standing) expect(childEvents).toContainEqual(expect.objectContaining({ type: "permission.granted", grant: expect.objectContaining({ subject: child.subject }) }));
    else expect(childEvents).toContainEqual(expect.objectContaining({ type: "tool.denied", name: "bash" }));
  };
  try { await startTui({ root, provider: "anthropic", model: "fake", subagents: true, allow: ["subagent"], repoMap: false, shell: shell.path, maxTurns: "5", maxTokensPerTurn: "100" }); }
  finally { if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", descriptor); }
});
