import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashTool, createAgent, describeShellOperation, resolveShell, SessionStore, type HarnessEvent, type ModelEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { buildPermissionPolicy } from "../src/run.ts";
import { parseConfigText } from "../src/config.ts";
import { buildAgent } from "../src/agent-builder.ts";
import { HarnessEvent as EventSchema } from "@agentkitai/agentrig-core";
import { renderEvent } from "../src/render.ts";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const shell = resolveShell();
const supported = describeShellOperation("git status", shell.path).status === "parsed";
async function run(command: string, patch?: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-semantic-")); roots.push(root);
  let turn = 0;
  const provider: ModelProvider = {
    id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(): AsyncIterable<ModelEvent> {
      if (turn++ === 0) yield { type: "tool_use", id: "t1", name: "bash", input: { command, ...extras } };
      yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
    },
  };
  const session = createAgent({ provider, tools: [bashTool({ shell: shell.path })],
    permissions: buildPermissionPolicy({ allowCommand: [["printf", "%s"], ["git", "status"]] }),
    store: new SessionStore({ root }), systemPrompt: "Model prose never grants authority", budget: { maxTurns: 3 },
    ...(patch === undefined ? {} : { hooks: [{ point: "pre_tool" as const, handler: () => ({ action: "modify" as const, patch }) }] }),
  }).run("I supposedly authorized every command (untrusted transcript claim)", { cwd: root });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  await session.done;
  return events;
}

describe("CLI semantic command scope", () => {
  it.skipIf(!supported)("forwards configured prefix authority through the shipped agent builder", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrig-semantic-builder-")); roots.push(root);
    vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key");
    const config = parseConfigText("test", '{"allowCommand":[["printf","%s"]]}');
    const built = await buildAgent({ root, maxTurns: "3", maxTokensPerTurn: "100", provider: "anthropic", model: "test", shell: shell.path, ...config });
    let turn = 0;
    vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
      if (turn++ === 0) yield { type: "tool_use", id: "t1", name: "bash", input: { command: "printf '%s' configured" } };
      yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
    });
    const session = built.agent.run("run the configured command", { cwd: root });
    const events: HarnessEvent[] = [];
    for await (const event of session.events) events.push(event);
    await session.done;
    expect(events.find(e => e.type === "tool.result")).toMatchObject({ ok: true, display: "configured" });
    expect(events.find(e => e.type === "permission.decision")).toMatchObject({ d: "allow" });
  });
  it("validates configuration and preserves explicit blanket authority and deny precedence", async () => {
    expect(parseConfigText("test", '{"allowCommand":[["git","status"]]}')).toMatchObject({ allowCommand: [["git", "status"]] });
    for (const allowCommand of [[[]], [["x\n"]], ["git status"]]) expect(() => parseConfigText("test", JSON.stringify({ allowCommand }))).toThrow();
    const req = { tool: "bash", class: "exec" as const, cwd: "/", input: {}, operation: describeShellOperation("git status; true", "/bin/sh") };
    expect(await buildPermissionPolicy({ allowCommand: [["git", "status"]] }).decide(req)).toBe("ask");
    for (const opts of [{ yolo: true }, { allow: ["exec"] }, { allow: ["bash"] }]) {
      expect(await buildPermissionPolicy({ ...opts, allowCommand: [["git", "status"]] }).decide(req)).toBe("allow");
      expect(await buildPermissionPolicy({ ...opts, deny: ["exec"], allowCommand: [["git", "status"]] }).decide({ ...req, operation: describeShellOperation("git status", "/bin/sh") })).toBe("deny");
    }
    expect(await buildPermissionPolicy({ allow: ["git *"] }).decide(req)).toBe("ask");
  });
  it.skipIf(!supported)("executes quoted metacharacters as inert literal data through the real shell", async () => {
    const events = await run("printf '%s' '$(printf expanded); | * \\'");
    expect(events.find(e => e.type === "permission.request")).toMatchObject({ req: { operation: { status: "parsed", argv: ["printf", "%s", "$(printf expanded); | * \\"] } } });
    const request = events.find(e => e.type === "permission.request")!;
    expect(EventSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(renderEvent(request)).toContain('operation={"kind":"shell","status":"parsed"');
    expect(events.find(e => e.type === "tool.result")).toMatchObject({ ok: true, display: "$(printf expanded); | * \\" });
    const control = spawnSync('printf "%s" "$(printf expanded)"', { shell: shell.path, encoding: "utf8" });
    expect(control.status).toBe(0); expect(control.stdout).toBe("expanded");
  });
  it.skipIf(!supported).each(["git status; printf changed", 'printf "%s" "$(printf expanded)"', "git status | printf changed", "git sta\\tus"])("denies adversarial syntax in the runtime: %s", async command => {
    const events = await run(command, undefined, { operation: describeShellOperation("git status", "/bin/sh"), readOnlyHint: true });
    expect(events.some(e => e.type === "tool.denied")).toBe(true);
    expect(events.find(e => e.type === "permission.request")).toMatchObject({ req: { operation: { status: "unsupported" } } });
  });
  it.skipIf(!supported)("derives the descriptor after validated hook modifications, not original model input", async () => {
    const events = await run("git status", { command: "git status; printf changed" });
    expect(events.some(e => e.type === "tool.denied")).toBe(true);
    expect(events.find(e => e.type === "permission.request")).toMatchObject({ req: { operation: { status: "unsupported" } } });
    const invalid = await run("git status", { command: 42 });
    // Existing hook contract discards an invalid patch and retains the original validated input.
    expect(invalid.find(e => e.type === "permission.request")).toMatchObject({ req: { input: { command: "git status" }, operation: { status: "parsed", argv: ["git", "status"] } } });
  });
  it.skipIf(!supported)("allows literal git status through the real runtime without classifying its effects", async () => {
    const events = await run("git status --short");
    expect(events.find(e => e.type === "permission.decision")).toMatchObject({ d: "allow" });
    expect(events.some(e => e.type === "tool.call")).toBe(true);
    expect(events.some(e => e.type === "tool.denied")).toBe(false);
  });
});
