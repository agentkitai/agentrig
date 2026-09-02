/**
 * Runs one session in a bare Node process: a tool that never returns and ignores its signal,
 * which aborts the session from inside itself (so the abort provably lands while the tool is
 * running, whatever the host's speed), then `await session.done`. Vitest keeps the event loop alive, so only a separate
 * process can show whether the loop's own grace timer keeps the process alive long enough to write
 * `session.end` (#86: an unref'd timer let Node exit mid-grace with no end written, exit code 0).
 * Invoked by subagent.test.ts via tsx: `abort-exit.ts <store-root> <abortGraceMs>`.
 */
import { z } from "zod";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type ModelEvent,
  type ModelProvider,
} from "../../src/index.js";

const root = process.argv[2];
if (root === undefined) throw new Error("usage: abort-exit.ts <store-root> [abortGraceMs]");
const abortGraceMs = Number(process.argv[3] ?? "300");

class OneHangingCall implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  private readonly turns: ModelEvent[][] = [[
    { type: "tool_use", id: "h1", name: "hang", input: {} },
    { type: "usage", usage: { input: 1, output: 1 } },
    { type: "stop", reason: "tool_use" },
  ]];
  async *stream(): AsyncIterable<ModelEvent> {
    yield* this.turns.shift() ?? [{ type: "stop", reason: "end_turn" }];
  }
}

let abortSession: () => void = () => {};
const hang: AnyTool = {
  name: "hang",
  description: "never returns and ignores its signal",
  inputSchema: z.object({}),
  permission: "read",
  paths: () => [],
  execute: () => {
    setTimeout(() => abortSession(), 10);
    return new Promise(() => {});
  },
};

const agent = createAgent({
  provider: new OneHangingCall(),
  tools: [hang],
  permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
  systemPrompt: "p",
  store: new SessionStore({ root }),
  budget: { maxTurns: 3 },
  maxTokensPerTurn: 100,
  abortGraceMs,
});
const session = agent.run("do it", { cwd: root });
abortSession = () => session.control.abort();
const summary = await session.done;
process.stdout.write(JSON.stringify({ id: summary.id, reason: summary.reason }) + "\n");
