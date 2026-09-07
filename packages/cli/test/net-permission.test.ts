import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, currentSandboxPolicy, NoneSandboxProvider, SessionStore, type ModelEvent } from "@agentkitai/agentrig-core";
import { z } from "zod";
import { buildAgent, buildSandbox } from "../src/agent-builder.ts";
import { buildPermissionPolicy } from "../src/run.ts";
import { initialPermissionScope, permissionEffectLines } from "../src/tui/permission-prompt.ts";
import { buildProgram } from "../src/program.ts";
import { loadRunConfig } from "../src/config.ts";

it.each([[], ["--sandbox-network"], ["--no-sandbox-network"]])("resolved network flags %j reach the actual net dispatch gate despite YOLO", async (...flags) => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-net-override-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(cwd);
  await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ sandboxNetwork: true, sandbox: "workspace-write", yolo: true }));
  const cmd = buildProgram().commands.find(c => c.name() === "run")!;
  cmd.parseOptions(flags);
  const resolved = await loadRunConfig(cmd, cmd.opts(), { cwd, home, env: {}, interactive: false, notice: () => {} });
  const sandbox = buildSandbox(resolved.sandbox!, "linux", resolved.sandboxNetwork);
  const calls = vi.fn(async () => ({ output: "inert", display: "inert" }));
  const prepare = vi.fn((command: Parameters<NonNullable<typeof sandbox.provider>["prepare"]>[0]) => command);
  const store = new SessionStore({ root: join(root, "sessions") }); let turn = 0;
  const agent = createAgent({ store, systemPrompt: "inert test", repoMap: false,
    sandbox: { ...sandbox, provider: { prepare } }, permissions: buildPermissionPolicy(resolved),
    tools: [{ name: "probe", description: "inert trusted net fixture", inputSchema: z.object({}), permission: "net", sandbox: "compatible", execute: calls }],
    provider: { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 10000 },
      async *stream(): AsyncIterable<ModelEvent> { if (turn++ === 0) yield { type: "tool_use", id: "probe", name: "probe", input: {} };
        yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" }; } },
  });
  const session = agent.run("exercise declared network operation", { cwd }); await session.done;
  const events = await store.readAll(session.id);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(calls).toHaveBeenCalledTimes(flags.includes("--no-sandbox-network") ? 0 : 1);
  expect(events.some(e => e.type === "sandbox.denied")).toBe(flags.includes("--no-sandbox-network"));
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const req = { tool: "probe", class: "net" as const, input: {}, cwd: "/fixture" };
it("CLI net rules remain independent from legacy network and explicit sandbox policy", async () => {
  expect(await buildPermissionPolicy({}).decide(req)).toBe("ask");
  expect(await buildPermissionPolicy({ allow: ["network"] }).decide(req)).toBe("ask");
  expect(await buildPermissionPolicy({ allow: ["net"] }).decide(req)).toBe("allow");
  expect(await buildPermissionPolicy({ allow: ["net"], deny: ["net"] }).decide(req)).toBe("deny");
  expect(await buildPermissionPolicy({ yolo: true }).decide(req)).toBe("allow");
  expect(buildSandbox("workspace-write", "linux").network).toBeUndefined();
  expect(buildSandbox("workspace-write", "linux", true).network).toBe(true);
  expect(buildSandbox("read-only", "darwin", true).network).toBe(true);
  expect(() => buildSandbox("read-only", "win32", true)).toThrow();
  expect(() => buildSandbox("none", "linux", "true" as never)).toThrow();
});
it.each([false, true])("actual CLI builder forwards explicit sandbox network=%s without implying OS isolation in none mode", async sandboxNetwork => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-net-")); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  const prepare = vi.spyOn(NoneSandboxProvider.prototype, "prepare");
  const built = await buildAgent({ root, provider: "anthropic", model: "fixture", sandbox: "none", sandboxNetwork,
    yolo: true, repoMap: false, maxTurns: "2", maxTokensPerTurn: "100" });
  // Replace only the fixture tool's trusted implementation. No shell or network I/O occurs.
  const probe = built.tools.find(t => t.name === "bash")!;
  probe.permission = "net"; probe.sandbox = "compatible";
  const observed: unknown[] = [];
  probe.execute = async () => { observed.push(currentSandboxPolicy()); return { output: "inert", display: "inert" }; };
  let turn = 0;
  built.provider.stream = async function* (): AsyncIterable<ModelEvent> {
    if (turn++ === 0) yield { type: "tool_use", id: "probe", name: "bash", input: { command: "unused" } };
    yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
  };
  await built.agent.run("test declared net tool", { cwd: root }).done;
  expect(observed).toEqual([undefined]); expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]![1].network).toBe(sandboxNetwork ? true : undefined);
});
it("net prompt states unknown destinations, and sandbox consent cannot become a narrow standing scope", () => {
  expect(permissionEffectLines(req).join("\n")).toContain("Network access requested; destinations and other effects are not established.");
  expect(() => initialPermissionScope({ ...req, origin: "sandbox-escalation", paths: ["/fixture"] })).toThrow(/separate consent/);
});
