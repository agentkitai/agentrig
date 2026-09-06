import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { createAgent, RulePolicy, SessionStore, type AgentConfig, type ModelEvent, type ModelProvider,
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

// Captured before extraction on main063cac6. Full serialized traces, not selected fields.
it.each<Scenario>(["normal", "between-call abort", "last-call abort", "truncated"])("preserves pre-extraction %s bytes", async kind => {
  const result = await scenario(kind);
  expect(JSON.stringify(result)).toMatchSnapshot();
  expect(result.executed).toEqual(kind === "truncated" ? [] : kind === "between-call abort" ? ["one"] : ["one", "two"]);
});
