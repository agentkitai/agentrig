import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessEvent, ModelEvent, ModelRequest, PermissionRequest, Session } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.js";
import * as builders from "../src/agent-builder.js";
import { runCommand, type RunOptions } from "../src/run.js";

const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { session.control.abort(); await session.done.catch(() => undefined); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("headless completion distinguishes current requests from cumulative resumed turns and usage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-request-summary-"))); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture-key");
  const options = { root, provider: "anthropic", model: "fixture", headless: true, packages: false,
    extensionDiscovery: false, skillDiscovery: false, repoMap: false,
    maxTurns: "3", maxTokensPerTurn: "128", supervisorSoft: "0.8", supervisorTurnsRemaining: "15",
    dreamEverySessions: "10", dreamEveryHours: "24" } as RunOptions;
  const built = await buildAgent(options);
  vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    yield { type: "usage", usage: { input: 10, cacheRead: 20, output: 3 } };
    yield { type: "stop", reason: "end_turn" };
  });
  vi.spyOn(builders, "buildAgent").mockResolvedValue(built);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const originalExitCode = process.exitCode;
  try {
    const first = await runCommand("first", options);
    expect(first).toBeDefined();
    await runCommand("follow-up", { ...options, resume: first!.id });
    const output = log.mock.calls.map(args => args.join(" ")).join("\n");
    expect(output).toContain("1 model request(s) this run; session totals: 1 loop turn(s), 30 in (20 cached) / 3 out");
    expect(output).toContain("1 model request(s) this run; session totals: 2 loop turn(s), 60 in (40 cached) / 6 out");
  } finally { process.exitCode = originalExitCode; }
});

// Scripted decisions test guidance delivery and unchanged runtime gates, not model judgment.
it.each(["allow", "deny"] as const)("assembled guidance leaves delegation available and obeys %s exec consent", async decision => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-delegation-guidance-"))); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture-key");
  const onAsk = vi.fn(async (_request: PermissionRequest) => decision);
  const built = await buildAgent({ root, provider: "anthropic", model: "fixture", subagents: true,
    maxTurns: "3", maxTokensPerTurn: "128", packages: false, extensionDiscovery: false, skillDiscovery: false, repoMap: false }, { onAsk });
  const requests: ModelRequest[] = []; let parentCalls = 0;
  vi.spyOn(built.provider, "stream").mockImplementation(async function* (request): AsyncIterable<ModelEvent> {
    requests.push(request);
    if (request.system.includes("You are a subagent.")) {
      yield { type: "text_delta", text: "bounded child result" };
      yield { type: "stop", reason: "end_turn" }; return;
    }
    if (parentCalls++ === 0) {
      yield { type: "tool_use", id: "delegation", name: "subagent", input: { task: "Compare two supplied definitions and return one distinction." } };
      yield { type: "stop", reason: "tool_use" };
    } else { yield { type: "text_delta", text: "direct final answer" }; yield { type: "stop", reason: "end_turn" }; }
  });
  const session = built.agent.run("Explain this straightforward concept", { cwd: root }); sessions.push(session);
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event);
  await session.done;
  const initial = requests[0]!;
  expect(initial.system).toContain("Handle straightforward explanations directly");
  expect(initial.system).toContain("concrete bounded independent subtask");
  expect(initial.system).toContain("clear benefit");
  expect(initial.system).toContain("Batch independent reads/searches");
  expect(initial.system).toContain("Lead with a concise answer");
  expect(initial.system).toContain("Never skip required checks");
  const advertised = initial.tools.find(tool => tool.name === "subagent");
  expect(advertised).toBeDefined();
  expect(advertised!.description).toContain("not a prerequisite for answering");
  expect(advertised!.description).toContain("self-contained inputs and an expected result");
  expect(advertised!.description).toContain("Never launch a nested `agentrig run`");
  expect(onAsk).toHaveBeenCalledTimes(1);
  expect(onAsk.mock.calls[0]![0]).toMatchObject({ tool: "subagent", class: "exec" });
  expect(events.some(event => event.type === "subagent.spawn")).toBe(decision === "allow");
  expect(events.some(event => event.type === "tool.denied" && event.name === "subagent")).toBe(decision === "deny");
});
