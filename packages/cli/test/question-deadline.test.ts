import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { askUserTool, createAgent, RulePolicy, SessionStore, type ModelProvider, type Session } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
afterEach(() => vi.useRealTimers());

it("the core deadline owns timeout attribution through the actual controller question handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-question-deadline-"));
  const store = new SessionStore({ root: join(root, "logs") }); let calls = 0;
  const controller = new TuiController({ cwd: root, agent: { run() { throw new Error("unused"); } } });
  let ready!: () => void; const entered = new Promise<void>(resolve => { ready = resolve; });
  const provider: ModelProvider = { id: "fixture", model: "fixture",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { calls++; yield { type: "tool_use", id: "ask", name: "ask_user", input: { prompt: "Choose", options: ["One", "Two"] } }; yield { type: "stop", reason: "tool_use" }; } };
  const agent = createAgent({ provider, store, repoMap: false, systemPrompt: "fixture", tools: [askUserTool()],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    onQuestion: (request, signal) => { const pending = controller.askQuestion(request, signal); ready(); return pending; } });
  const readiness = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let session: Session | undefined;
  try {
    session = agent.run("Choose", { cwd: root });
    await Promise.race([entered, delay(4000, undefined, { signal: readiness.signal }).then(() => { throw new Error("question handler not reached"); })]);
    readiness.abort(); expect(controller.snapshot().question).not.toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await session.done).reason).toBe("error");
    expect((await store.readAll(session.id)).filter(event => event.type === "question.answered")).toMatchObject([{ outcome: "timeout" }]);
    expect(controller.snapshot().question).toBeNull(); expect(calls).toBe(1);
    expect(controller.permissionGrants.list()).toEqual([]);
  } finally {
    readiness.abort(); session?.control.abort(); vi.useRealTimers();
    await session?.done; await controller.shutdown(); await rm(root, { recursive: true, force: true });
  }
}, 10_000);
