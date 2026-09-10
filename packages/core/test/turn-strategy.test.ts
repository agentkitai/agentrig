import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, RulePolicy, SessionStore, sequential, type AgentConfig, type ModelEvent, type ModelProvider,
  type ModelRequest, type Session } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Scenario = "normal" | "between-call abort" | "last-call abort" | "truncated";
async function scenario(kind: Scenario, overrides: Partial<AgentConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-turn-strategy-")); roots.push(root);
  const store = new SessionStore({ root, now: () => 42, newId: () => "strategy-trace" });
  const requests: ModelRequest[] = []; const executed: string[] = []; let turn = 0; let session!: Session;
  const provider: ModelProvider = { id: "strategy", model: "fixture",
    capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 },
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request));
      if (turn++ === 0) {
        yield { type: "tool_use", id: "one", name: "probe", input: { value: "one" } };
        yield { type: "tool_use", id: "two", name: "probe", input: { value: "two" } };
        yield { type: "usage", usage: { input: 3, output: 2 } };
        yield { type: "stop", reason: kind === "truncated" ? "max_tokens" : "tool_use" };
      } else {
        yield { type: "text_delta", text: "finished" };
        yield { type: "usage", usage: { input: 2, output: 1 } };
        yield { type: "stop", reason: "end_turn" };
      }
    } };
  const agent = createAgent({ provider, store, now: () => 42, repoMap: false, systemPrompt: "strategy fixture",
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    tools: [{ name: "probe", description: "inert probe", permission: "read", inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => {
        executed.push(value);
        if ((kind === "between-call abort" && value === "one") || (kind === "last-call abort" && value === "two")) session.control.abort();
        return { output: value, display: value };
      } }], ...overrides });
  session = agent.run("strategy task", { cwd: "/agentrig-strategy-synthetic" });
  const events = []; for await (const event of session.events) events.push(event);
  const summary = await session.done;
  const snapshot = await store.readSnapshot(session.id);
  const log = await readFile(join(root, `${session.id}.jsonl`), "utf8");
  expect(log).toBe(events.map(event => JSON.stringify(event) + "\n").join(""));
  return { log, requests, summary, snapshot, executed };
}

// Captured before extraction on main 063cac6. Full serialized traces, not selected fields.
// Ordinary-session UX adds the runtime session.finishing boundary; goldens retain it and
// its sequence shifts explicitly rather than filtering new lifecycle events out of comparisons.
it.each<Scenario>(["normal", "between-call abort", "last-call abort", "truncated"])("preserves pre-extraction %s bytes", async kind => {
  const result = await scenario(kind);
  expect(JSON.stringify(result)).toMatchSnapshot();
  expect(JSON.stringify(await scenario(kind, { turnStrategy: sequential }))).toBe(JSON.stringify(result));
  expect(result.executed).toEqual(kind === "truncated" ? [] : kind === "between-call abort" ? ["one"] : ["one", "two"]);
});

it("awaits each callback before starting the next even when parallelTools is advertised", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const stages: string[] = [];
  const execute = vi.fn(async (calls: Parameters<typeof sequential.execute>[0], context: Parameters<typeof sequential.execute>[1]) =>
    sequential.execute(calls, { ...context, runTool: async call => {
      stages.push(`start-${call.id}`);
      if (call.id === "one") { entered(); await gate; }
      const result = await context.runTool(call); stages.push(`end-${call.id}`); return result;
    } }));
  const running = scenario("normal", { turnStrategy: { execute } });
  await started;
  try { expect(stages).toEqual(["start-one"]); }
  finally { release(); }
  const result = await running;
  expect(execute).toHaveBeenCalledOnce(); expect(result.executed).toEqual(["one", "two"]);
  expect(stages).toEqual(["start-one", "end-one", "start-two", "end-two"]);
});

it("does not invoke the injected strategy for a truncated response", async () => {
  const execute = vi.fn(sequential.execute);
  const result = await scenario("truncated", { turnStrategy: { execute } });
  expect(execute).not.toHaveBeenCalled(); expect(result.executed).toEqual([]);
});

it("injected scheduling still uses post-hook schema validation and base permissions", async () => {
  const execute = vi.fn(sequential.execute);
  const result = await scenario("normal", { turnStrategy: { execute },
    permissions: new RulePolicy([{ class: "read", decision: "deny" }]),
    hooks: [{ point: "pre_tool", handler: () => ({ action: "modify", patch: { value: 42 } }) }],
  });
  expect(execute).toHaveBeenCalledOnce(); expect(result.executed).toEqual([]);
  expect(result.log).toContain("did not match its schema; using the original input");
  const invalidPatch = await scenario("normal", { turnStrategy: sequential,
    hooks: [{ point: "pre_tool", handler: () => ({ action: "modify", patch: { value: 42 } }) }],
  });
  expect(invalidPatch.executed).toEqual(["one", "two"]);
  const denied = await scenario("normal", { turnStrategy: sequential, permissions: new RulePolicy([{ class: "read", decision: "deny" }]) });
  expect(denied.executed).toEqual([]); expect(denied.log).toContain('"type":"tool.denied"');
});

it("a trusted strategy rejection follows existing fatal-error settlement", async () => {
  const result = await scenario("normal", { turnStrategy: { async execute() { throw Error("strategy fixture failure"); } } });
  expect(result.summary.reason).toBe("error"); expect(result.executed).toEqual([]);
  expect(result.log).toContain('"message":"strategy fixture failure","fatal":true');
  expect(JSON.parse(result.log.trim().split("\n").at(-1)!).type).toBe("session.end");
});

it("pre-aborted sequential dispatches nothing, while an empty batch stays a no-op", async () => {
  const abort = new AbortController(); abort.abort(); const runTool = vi.fn();
  expect(await sequential.execute([{ id: "one", name: "probe", input: {} }], { signal: abort.signal, runTool }))
    .toEqual({ results: [], interrupted: true });
  expect(await sequential.execute([], { signal: abort.signal, runTool })).toEqual({ results: [], interrupted: false });
  expect(runTool).not.toHaveBeenCalled();
});
