import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgent, RulePolicy, defaultRules, SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";

it("delivers the fake provider's first byte as a persisted stream event within one event-loop tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-stream-"));
  let tick = 0, firstByteTick: number | undefined, eventTick: number | undefined;
  let active = true;
  let timer: NodeJS.Immediate;
  const count = () => { if (active) { tick++; timer = setImmediate(count); } };
  timer = setImmediate(count);
  const provider: ModelProvider = {
    id: "fake", model: "feel", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 10_000 },
    async *stream() {
      firstByteTick = tick;
      yield { type: "text_delta", text: "first byte" };
      yield { type: "stop", reason: "end_turn" };
    },
  };
  const store = new SessionStore({ root });
  try {
    const agent = createAgent({ provider, tools: [], permissions: new RulePolicy(defaultRules), systemPrompt: "test", store, repoMap: false });
    const session = agent.run("stream the first byte", { cwd: root });
    for await (const event of session.events) {
      if (event.type === "model.delta" && eventTick === undefined) eventTick = tick;
    }
    await session.done;
    expect(firstByteTick).toBeDefined();
    expect(eventTick).toBeDefined();
    expect(eventTick! - firstByteTick!).toBeLessThanOrEqual(1);
    const persisted = [];
    for await (const event of store.read(session.id)) persisted.push(event);
    expect(persisted.find(e => e.type === "model.delta")).toMatchObject({ text: "first byte" });
    expect(persisted.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
  } finally {
    active = false; clearImmediate(timer); await rm(root, { recursive: true, force: true });
  }
});

it("creates a first-delta log and never advances its sequence past a failed stream append", async () => {
  const temp = await mkdtemp(join(tmpdir(), "feel-append-"));
  const store = new SessionStore({ root: join(temp, "new-root") });
  const id = store.create();
  try {
    expect(await store.append(id, { type: "model.delta", text: "first" })).toMatchObject({ seq: 0 });
    const path = store.pathFor(id), backup = `${path}.saved`;
    await rename(path, backup);
    await mkdir(path); // Deterministic write failure on all supported platforms, not chmod/root-dependent.
    await expect(store.append(id, { type: "model.delta", text: "must not commit" })).rejects.toThrow();
    await rm(path, { recursive: true });
    await rename(backup, path);
    expect(await store.append(id, { type: "model.delta", text: "second" })).toMatchObject({ seq: 1 });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("must not commit");
    const events = [];
    for await (const event of store.read(id)) events.push(event);
    expect(events).toMatchObject([{ seq: 0, text: "first" }, { seq: 1, text: "second" }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
