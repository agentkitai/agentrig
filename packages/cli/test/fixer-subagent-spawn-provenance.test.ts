import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  subagentTool,
  type EventPayload,
  type ModelEvent,
  type ModelProvider,
} from "@agentkitai/agentrig-core";

class DoneProvider implements ModelProvider {
  readonly id = "fixer-provenance-fixture";
  readonly model = "fixture";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 10_000 };

  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "stop", reason: "end_turn" };
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-fixer-spawn-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fixer subagent spawn provenance", () => {
  it.each([
    {
      name: "unlabeled invocation preserves the complete fixer task",
      input: { task: "Repair X-F1 with its complete durable receipt and source URL" },
      recorded: "Repair X-F1 with its complete durable receipt and source URL",
    },
    {
      name: "optional label replaces the complete task in the immutable event",
      input: { task: "Repair X-F1 with its complete durable receipt and source URL", label: "fixer" },
      recorded: "fixer",
    },
  ])("$name", async ({ input, recorded }) => {
    const provider = new DoneProvider();
    const events: EventPayload[] = [];
    const tool = subagentTool({
      createAgent,
      childConfig: () => ({
        provider,
        tools: [],
        permissions: new RulePolicy([]),
        systemPrompt: "fixture child",
        store: new SessionStore({ root }),
        maxTokensPerTurn: 100,
      }),
      maxTurns: 1,
    });

    await tool.execute(input, {
      cwd: root,
      sessionId: "fixer-parent",
      emit: event => events.push(event),
      signal: new AbortController().signal,
    });

    const spawn = events.find(event => event.type === "subagent.spawn");
    expect(spawn).toMatchObject({ type: "subagent.spawn", task: recorded });
  });
});
