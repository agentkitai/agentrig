import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { limitProvider, type ModelProvider, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
const request: ModelRequest = { system: "", messages: [], tools: [], maxTokens: 1 };
it("serializes fake sessions on one entry, emits wait, releases on return; other entries remain independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrency-"));
  let active = 0, peak = 0;
  const fake: ModelProvider = { id: "fake", model: "m", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10 },
    async *stream() { active++; peak = Math.max(peak, active); try { yield { type: "text_delta", text: "held" }; } finally { active--; } } };
  const one = limitProvider(fake, { root, entry: "login", maxConcurrent: 1 });
  const two = limitProvider(fake, { root, entry: "login", maxConcurrent: 1 });
  const other = limitProvider(fake, { root, entry: "other", maxConcurrent: 1 });
  const signal = new AbortController().signal;
  const a = one.stream(request, signal)[Symbol.asyncIterator]();
  const b = two.stream(request, signal)[Symbol.asyncIterator]();
  const c = other.stream(request, signal)[Symbol.asyncIterator]();
  try {
    expect((await a.next()).value?.type).toBe("text_delta");
    expect((await b.next()).value).toEqual({ type: "wait", entry: "login", maxConcurrent: 1 });
    expect(active).toBe(1);
    let entered = false;
    const pending = b.next().then(value => { entered = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(entered).toBe(false);
    expect((await c.next()).value?.type).toBe("text_delta");
    await c.return?.();
    await a.return?.();
    expect((await pending).value?.type).toBe("text_delta");
    expect(peak).toBe(2);
  } finally { await a.return?.(); await b.return?.(); await c.return?.(); await rm(root, { recursive: true, force: true }); }
});
it("aborts a waiting session without opening a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrency-"));
  const fake: ModelProvider = { id: "fake", model: "m", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10 }, async *stream(): AsyncGenerator<ModelEvent> { yield { type: "stop", reason: "end_turn" }; } };
  const provider = limitProvider(fake, { root, entry: "login", maxConcurrent: 1 });
  const controller = new AbortController();
  const a = provider.stream(request, controller.signal)[Symbol.asyncIterator]();
  const b = provider.stream(request, controller.signal)[Symbol.asyncIterator]();
  try { await a.next(); expect((await b.next()).value?.type).toBe("wait"); controller.abort(); await expect(b.next()).rejects.toThrow(); }
  finally { await a.return?.(); await b.return?.(); await rm(root, { recursive: true, force: true }); }
});
it("coordinates a separate process through shared filesystem slots", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const root = await mkdtemp(join(tmpdir(), "concurrency-process-"));
  const fake: ModelProvider = { id: "fake", model: "m", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10 }, async *stream() { yield { type: "stop", reason: "end_turn" }; } };
  const held = limitProvider(fake, { root, entry: "shared", maxConcurrent: 1 }).stream(request, new AbortController().signal)[Symbol.asyncIterator]();
  await held.next();
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { limitProvider } from ${JSON.stringify(entry)};
    const fake = { id: 'fake', model: 'm', capabilities: {}, async *stream() { yield {type:'stop',reason:'end_turn'}; } };
    for await (const event of limitProvider(fake, {root:process.argv[1],entry:'shared',maxConcurrent:1}).stream({},new AbortController().signal)) console.log(event.type);
  `, root], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  const finished = once(child, "exit");
  try {
    await once(child.stdout, "data");
    expect(output).toBe("wait\n");
    await held.return?.();
    expect((await finished)[0]).toBe(0);
    expect(output).toBe("wait\nstop\n");
  } finally { child.kill(); await finished; await held.return?.(); await rm(root, { recursive: true, force: true }); }
}, 10000);
