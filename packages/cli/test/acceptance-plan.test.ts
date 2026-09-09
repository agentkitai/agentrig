import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgent, renderPlanAcceptance as corePlanAcceptance, renderPlanItems, RulePolicy, SessionStore, updatePlanTool, type ModelProvider } from "@agentkitai/agentrig-core";
import { initialState, reduce } from "@agentkitai/agentrig-supervisor";
import { renderChatEvent, renderEvent, renderPlanAcceptance } from "../src/render.ts";
import { TuiController } from "../src/tui/controller.ts";

it("shares the core acceptance formatter rather than maintaining another declaration string", () => {
  expect(renderPlanAcceptance).toBe(corePlanAcceptance);
});

it("/plan shares the bounded declaration wording and avoids per-step undeclared repetition", async () => {
  const controller = new TuiController({ cwd: process.cwd(), agent: { run() { throw Error("no provider call"); } } as never });
  const items = [{ id: "a", text: "first", status: "pending" as const }, { id: "b", text: "second", status: "pending" as const }];
  try {
    controller.snapshot().plan = items;
    await controller.submit("/plan");
    expect(controller.snapshot().lines.at(-1)!.text).toBe(renderPlanItems(items));
  } finally { await controller.shutdown(); }
});

it("actual plan declarations survive storage, supervisor state and /plan without turning done into verified proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-plan-ui-")); let controller: TuiController | undefined;
  try {
    const items = [{ id: "a", text: "declared done", status: "done", accept: "endpoint returns 401 without a token" }, { id: "b", text: "legacy done", status: "done" }];
    let turn = 0;
    const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
      async *stream() { if (turn++ === 0) yield { type: "tool_use", id: "plan", name: "update_plan", input: { items } }; yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" }; } };
    const store = new SessionStore({ root });
    controller = new TuiController({ cwd: root, agent: createAgent({ provider, store, tools: [updatePlanTool()], systemPrompt: "fixture", repoMap: false, permissions: new RulePolicy([{ class: "read", decision: "allow" }]) }) });
    await controller.submit("declare checks");
    expect(controller.snapshot().plan).toEqual(items);
    await controller.submit("/plan");
    const text = controller.snapshot().lines.at(-1)!.text;
    expect(text).toContain('accept: "endpoint returns 401 without a token" (declared, unverified)');
    expect(text).toContain("undeclared (unverified)");
    const events = await store.readAll(controller.snapshot().sessionId!); const state = initialState();
    for (const event of events) reduce(state, event);
    expect(state.plan).toEqual(items);
    const event = events.find(event => event.type === "plan.updated")!;
    expect(renderEvent(event)).toContain("endpoint returns 401 without a token");
    expect(renderEvent(event)).toContain("undeclared (unverified)");
    expect(renderChatEvent(event)).toContain("acceptance 1/2 declared, unverified");
  } finally { await controller?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
