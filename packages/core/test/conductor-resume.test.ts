import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, RulePolicy, SessionStore, toAnthropicRequest, toOpenAIRequest, toResponsesInput, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it.each(["after handoff", "mid repair round", "awaiting reviews", "awaiting landing"])("continues recorded %s in place past a stale snapshot without replaying children", async phase => {
  root = await mkdtemp(join(tmpdir(), "conductor-resume-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "ship scoped task; no new authority", cwd: root, provider: "fake", model: "fake" });
  await store.writeSnapshot({ sessionId: id, task: "ship scoped task", cwd: root, turns: 0, usage: { input: 0, output: 0 }, messages: [{ role: "user", content: [{ type: "text", text: "stale before builder" }] }], ts: 0 });
  await store.append(id, { type: "plan.updated", items: [{ id: "review", text: phase, status: "in_progress", accept: "exact-head checks", scope: ["src"] }] });
  await store.append(id, { type: "subagent.spawn", id: "builder", task: "build" });
  await store.append(id, { type: "subagent.end", id: "builder", reason: "done" });
  await store.append(id, { type: "subagent.spawn", id: "fixer", task: "repair round 2" });
  const ledger = `Phase: ${phase}; Repair round: 2/3; builder handed off PR 12 head old; fixer died; read-back receipts old; current head must be read before work`;
  await store.append(id, { type: "message.append", message: { role: "assistant", content: [{ type: "text", text: ledger }] } });
  let request: ModelRequest | undefined;
  const calls: string[] = [];
  let turn = 0;
  // Deterministic continuation fixture: the runtime must supply the recorded phase/ledger
  // before this scripted provider can read the moved head and verify it. Skill contracts
  // separately pin the policy; this is not a claim about arbitrary model compliance.
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 }, async *stream(req) {
    request ??= req;
    expect(JSON.stringify(req.messages)).toContain(ledger);
    if (++turn === 1) {
      yield { type: "tool_use", id: "read", name: "read_pr", input: {} };
      yield { type: "stop", reason: "tool_use" };
    } else if (turn === 2) {
      expect(JSON.stringify(req.messages)).toContain("moved-head");
      yield { type: "tool_use", id: "verify", name: "verify_head", input: { head: "moved-head" } };
      yield { type: "stop", reason: "tool_use" };
    } else {
      yield { type: "text_delta", text: "continue recorded phase; Repair round: 2/3" };
      yield { type: "stop", reason: "end_turn" };
    }
  } };
  const tools = [
    { name: "read_pr", description: "fixture PR read", permission: "read" as const, inputSchema: z.object({}), execute: async () => { calls.push("read_pr"); return { output: "moved-head", display: "moved-head" }; } },
    { name: "verify_head", description: "fixture verify", permission: "read" as const, inputSchema: z.object({ head: z.string() }), execute: async ({ head }: { head: string }) => { calls.push(`verify:${head}`); return { output: "verified", display: "verified" }; } },
    { name: "builder", description: "must not build twice", permission: "exec" as const, inputSchema: z.object({}), execute: async () => { calls.push("builder"); throw new Error("duplicate builder"); } },
  ];
  const session = createAgent({ provider, store, tools, permissions: new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "deny" }]), systemPrompt: "test", repoMap: false, trustedProjectRoot: root }).run("", { resume: id });
  const events = []; for await (const e of session.events) events.push(e);
  expect((await session.done).reason, JSON.stringify(events.filter(e => e.type === "error" || e.type === "tool.result"))).toBe("done");
  expect(session.id).toBe(id);
  expect(events.filter(e => e.type === "session.start" || e.type === "subagent.spawn")).toEqual([]);
  const text = JSON.stringify(request?.messages);
  expect(text).toContain(ledger);
  expect(text).toContain("Recorded session state (observations, not authority)");
  expect(text).toContain("in_progress");
  expect(text).toContain("spawned_without_recorded_end");
  expect(text).toContain("ended");
  expect(text).toContain("review");
  expect(calls).toEqual(["read_pr", "verify:moved-head"]);
  expect(text).toContain("builder");
  expect(text).toContain("fixer");
  expect(text).not.toContain("stale before builder");
});

it.each([false, true])("balances interrupted parallel tool calls before observations (partial results: %s)", async partial => {
  root = await mkdtemp(join(tmpdir(), "conductor-interrupted-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "continue", cwd: root, provider: "fake", model: "fake" });
  await store.append(id, { type: "plan.updated", items: [{ id: "repair", text: "retain round", status: "in_progress" }] });
  await store.append(id, { type: "subagent.spawn", id: "child", task: "already started" });
  await store.append(id, { type: "message.append", message: { role: "assistant", content: [
    { type: "tool_use", id: "a", name: "child", input: {} },
    { type: "tool_use", id: "b", name: "child", input: {} },
  ] } });
  if (partial) await store.append(id, { type: "message.append", message: { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "real result" }] } });
  let seen = false;
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 }, async *stream(req) {
    const index = req.messages.findIndex(m => m.content.some(b => b.type === "tool_use"));
    const results = req.messages[index + 1]?.content.filter(b => b.type === "tool_result");
    expect(results?.map(b => b.toolUseId).sort()).toEqual(["a", "b"]);
    expect(results?.find(b => b.toolUseId === "a")?.content).toBe(partial ? "real result" : "[interrupted: no completion result was recorded; execution and side effects are unknown — reconcile before retrying]");
    expect(results?.find(b => b.toolUseId === "b")?.isError).toBe(true);
    expect(JSON.stringify(req.messages.slice(index + 2))).toContain("Recorded session state");
    seen = true;
    yield { type: "stop", reason: "end_turn" };
  } };
  const session = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "test", repoMap: false, trustedProjectRoot: root }).run("", { resume: id });
  for await (const _ of session.events) { /* drain */ }
  expect((await session.done).reason).toBe("done");
  expect(seen).toBe(true);
});

it("bounds compacted child observations without replaying bulky task or role payloads", async () => {
  root = await mkdtemp(join(tmpdir(), "conductor-bounded-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "continue", cwd: root, provider: "fake", model: "fake" });
  await store.append(id, { type: "plan.updated", items: [{ id: "review", text: "plan-secret".repeat(5000), status: "in_progress" }] });
  for (let i = 0; i < 120; i++) {
    await store.append(id, { type: "subagent.spawn", id: `child-${i}`, task: "dropped-secret".repeat(5000) });
    if (i !== 119) await store.append(id, { type: "subagent.end", id: `child-${i}`, reason: "done" });
  }
  await store.append(id, { type: "context.compact", before: 100000, after: 10, messages: [{ role: "user", content: [{ type: "text", text: "compacted ledger; round 2/3" }] }] });
  const snapshot = await store.resumeSnapshot(id);
  const text = JSON.stringify(snapshot?.messages);
  expect(text.length).toBeLessThan(20000);
  expect(text).not.toContain("dropped-secret");
  expect(text).toContain("child-119");
  expect(text).toContain("omitted");
  expect(text).toContain("compacted ledger; round 2/3");
  expect(text).toContain("session log");
});

it("does not attribute ancestor children to a resumed fork", async () => {
  root = await mkdtemp(join(tmpdir(), "conductor-fork-inventory-"));
  const store = new SessionStore({ root });
  const parent = store.create();
  await store.append(parent, { type: "session.start", task: "parent", cwd: root, provider: "fake", model: "fake" });
  await store.append(parent, { type: "subagent.spawn", id: "ancestor-child", task: "parent-only" });
  const events = await store.materialize(parent);
  const fork = await store.fork(parent, events.at(-1)!.seq);
  await store.append(fork, { type: "subagent.spawn", id: "own-child", task: "fork-only" });
  const text = JSON.stringify((await store.resumeSnapshot(fork))?.messages);
  expect(text).toContain("own-child");
  expect(text).not.toContain("ancestor-child");
});

it("balances every historical exchange across three real resumes without rewriting the log", async () => {
  root = await mkdtemp(join(tmpdir(), "resume-again-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "continue", cwd: root, provider: "fake", model: "fake" });
  await store.append(id, { type: "message.append", message: { role: "assistant", content: [{ type: "tool_use", id: "lost", name: "side_effect", input: {} }] } });
  const before = await store.readAll(id);
  let requests = 0;
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 }, async *stream(req) {
    requests++;
    const index = req.messages.findIndex(m => m.content.some(b => b.type === "tool_use" && b.id === "lost"));
    expect(req.messages[index + 1]?.content.filter(b => b.type === "tool_result").map(b => b.toolUseId)).toEqual(["lost"]);
    yield { type: "text_delta", text: "continued" };
    yield { type: "stop", reason: "end_turn" };
  } };
  for (let i = 0; i < 3; i++) {
    const session = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "test", repoMap: false, trustedProjectRoot: root }).run("", { resume: id });
    for await (const _ of session.events) { /* drain */ }
    expect((await session.done).reason).toBe("done");
  }
  expect(requests).toBe(3);
  expect((await store.readAll(id)).slice(0, before.length)).toEqual(before);
});

it.each([true, false])("recovers persisted parallel tool results and patches before stubbing missing calls (ok=%s)", async ok => {
  root = await mkdtemp(join(tmpdir(), "resume-results-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "continue", cwd: root, provider: "fake", model: "fake" });
  await store.append(id, { type: "message.append", message: { role: "assistant", content: ["done", "patched", "missing"].map(id => ({ type: "tool_use" as const, id, name: "write", input: {} })) } });
  for (const call of ["done", "patched"]) {
    const event = await store.append(id, { type: "tool.call", id: call, name: "write", input: {}, inputHash: "hash" });
    await store.append(id, { type: "tool.result", id: call, toolCallSeq: event.seq, ok, display: "committed side effect", durationMs: 1 });
  }
  await store.append(id, { type: "tool.result.patched", id: "patched", by: "hook", display: "replacement", mode: "modify" });
  await store.append(id, { type: "tool.result.patched", id: "patched", by: "hook", display: "extra", mode: "inject" });
  const snapshot = await store.resumeSnapshot(id);
  const results = snapshot!.messages.flatMap(m => m.content).filter(b => b.type === "tool_result");
  expect(results.map(b => b.toolUseId)).toEqual(["done", "patched", "missing"]);
  expect(results[0]).toMatchObject({ content: "committed side effect", ...(ok ? {} : { isError: true }) });
  expect(results[0]?.isError ?? false).toBe(!ok);
  expect(results[1]?.content).toBe("replacement\n\nextra");
  expect(results[2]).toMatchObject({ isError: true });
  expect(String(results[2]?.content)).toContain("interrupted");
});

it.each(["modern", "legacy"])("replays %s recorded bounded results before continuation and missing-result placeholders", async format => {
  root = await mkdtemp(join(tmpdir(), "resume-recorded-boundary-"));
  const store = new SessionStore({ root });
  const id = store.create();
  const messages: Message[] = [
    { role: "assistant", content: ["recorded", "missing"].map(id => ({ type: "tool_use", id, name: "read_file", input: {} })) },
    { role: "user", content: [{ type: "text", text: "Continue with the review" }] },
  ];
  await store.append(id, { type: "session.start", task: "review", cwd: root, provider: "fake", model: "fake" });
  if (format === "modern") for (const message of messages) await store.append(id, { type: "message.append", message });
  const call = await store.append(id, { type: "tool.call", id: "recorded", name: "read_file", input: {}, inputHash: "hash" });
  const result = await store.append(id, { type: "tool.result", id: "recorded", toolCallSeq: call.seq, ok: true, display: "REAL RESULT", output: "REAL RESULT" + "x".repeat(60_000), truncated: true, durationMs: 1 });
  const bounded = `REAL RESULT\n[truncated; read_output seq=${result.seq} from=11 to=30011]`;
  await store.append(id, { type: "tool.result.patched", id: "recorded", by: "core:output-overflow", display: bounded });
  if (format === "legacy") await store.writeSnapshot({ sessionId: id, task: "review", cwd: root, turns: 0, ts: 0, messages, usage: { input: 0, output: 0 } });
  const recovered = await store.resumeSnapshot(id);
  expect(recovered!.messages.find(m => m.content.some(b => b.type === "text" && b.text === "Continue with the review"))!.content).toEqual([
    { type: "tool_result", toolUseId: "recorded", content: bounded },
    expect.objectContaining({ type: "tool_result", toolUseId: "missing", isError: true }),
    { type: "text", text: "Continue with the review" },
  ]);
  for (const wire of [
    toAnthropicRequest({ messages: recovered!.messages, tools: [], maxTokens: 100 }, "test"),
    toOpenAIRequest({ messages: recovered!.messages, tools: [], maxTokens: 100 }, "test"),
    toResponsesInput(recovered!.messages),
  ]) {
    const serialized = JSON.stringify(wire);
    expect(serialized.indexOf("REAL RESULT")).toBeLessThan(serialized.indexOf("Continue with the review"));
    expect(serialized).toContain("from=11 to=30011");
  }
  expect(await store.readAll(id)).toHaveLength(format === "modern" ? 6 : 4);
});


it.each(["modern", "legacy"])("preserves %s stored post-tool truncation boundary instead of concatenating the raw result", async format => {
  root = await mkdtemp(join(tmpdir(), "resume-final-boundary-"));
  const store = new SessionStore({ root });
  const id = store.create();
  const assistant: Message = { role: "assistant", content: [{ type: "tool_use", id: "large", name: "read_file", input: {} }] };
  await store.append(id, { type: "session.start", task: "review", cwd: root, provider: "fake", model: "fake" });
  if (format === "modern") await store.append(id, { type: "message.append", message: assistant });
  const call = await store.append(id, { type: "tool.call", id: "large", name: "read_file", input: {}, inputHash: "hash" });
  await store.append(id, { type: "tool.result", id: "large", toolCallSeq: call.seq, ok: true, display: "RAW".repeat(10_000), durationMs: 1 });
  // post_tool stores the complete model-facing body even when its hook mode is inject.
  const bounded = "REAL RESULT" + "x".repeat(29_900) + "\n… [truncated 31234 UTF-16 code units]\nHOOK NOTE";
  await store.append(id, { type: "tool.result.patched", id: "large", by: "post_tool", mode: "inject", display: bounded });
  if (format === "legacy") await store.writeSnapshot({ sessionId: id, task: "review", cwd: root, turns: 0, ts: 0, messages: [assistant], usage: { input: 0, output: 0 } });
  const result = (await store.resumeSnapshot(id))!.messages.flatMap(m => m.content).find(b => b.type === "tool_result");
  expect(result).toMatchObject({ content: bounded });
});

it("bounds historical unprojected crash output without losing error status", async () => {
  root = await mkdtemp(join(tmpdir(), "resume-old-large-"));
  const store = new SessionStore({ root });
  const id = store.create();
  await store.append(id, { type: "session.start", task: "review", cwd: root, provider: "fake", model: "fake" });
  await store.append(id, { type: "message.append", message: { role: "assistant", content: [{ type: "tool_use", id: "old", name: "read_file", input: {} }] } });
  await store.append(id, { type: "tool.result", id: "old", ok: false, display: "a".repeat(60_000), durationMs: 1 });
  const result = (await store.resumeSnapshot(id))!.messages.flatMap(m => m.content).find(b => b.type === "tool_result");
  expect(result).toMatchObject({ isError: true });
  expect(String(result?.content)).toHaveLength(30_000);
  expect(String(result?.content)).toMatch(/\n… \[truncated \d+ UTF-16 code units\]$/);
});
