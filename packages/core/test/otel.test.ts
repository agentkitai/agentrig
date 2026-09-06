import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, builtinTools, RulePolicy, SessionStore, OtelSink, OtlpExporter, OTEL_LIMITS, otelEndpoint,
  parallel, type OtlpSpan, type ModelProvider, type HarnessEvent, type Session } from "@agentkitai/agentrig-core";

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function collector(handler?: Parameters<typeof createServer>[0]) {
  const bodies: string[] = [];
  const server = createServer(handler ?? ((req, res) => { let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { bodies.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); }));
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, bodies, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/exact/traces` };
}
const span = (): OtlpSpan => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "tool", kind: 1,
  startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", attributes: [] });
function capture() { const spans: OtlpSpan[] = []; const counters = { dropped: 0, failed: 0, partial: 0, incomplete: 0, exported: 0 };
  const sink = new OtelSink({ push: s => spans.push(s), close: async () => {}, counters }); return { spans, sink }; }
async function run(observe?: (s: Session) => void, denied = false) {
  const root = await mkdtemp(join(tmpdir(), "otel-core-")); roots.push(root); let call = 0;
  const provider: ModelProvider = { id: "SECRET_PROVIDER", model: "SECRET_MODEL", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 },
    async *stream() { if (call++ === 0) {
      yield { type: "tool_use", id: "SECRET_CALL", name: "SECRET_TOOL", input: { value: "SECRET_INPUT" } };
      yield { type: "tool_use", id: "SECRET_CALL_TWO", name: "SECRET_TOOL", input: { value: "SECRET_INPUT_TWO" } };
      yield { type: "stop", reason: "tool_use" };
    } else { yield { type: "text_delta", text: "SECRET_OUTPUT" }; yield { type: "usage", usage: { input: 2, output: 1 }, reported: true }; yield { type: "stop", reason: "end_turn" }; } } };
  const agent = createAgent({ provider, store: new SessionStore({ root, now: () => 42, newId: () => "SECRET_SESSION" }), now: () => 42,
    repoMap: false, systemPrompt: "SECRET_PROMPT", permissions: new RulePolicy([{ class: "read", decision: denied ? "deny" : "allow" }]),
    ...(observe === undefined ? {} : { observeSession: observe }), turnStrategy: parallel({ maxConcurrency: 2 }),
    tools: [{ name: "SECRET_TOOL", description: "SECRET_DESCRIPTION", permission: "read", effects: "read-only", paths: () => [], inputSchema: z.object({ value: z.string() }),
      execute: async () => ({ output: "SECRET_RESULT", display: "SECRET_DISPLAY" }) }] });
  const session = agent.run("SECRET_TASK", { cwd: root }); await session.done;
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event);
  return { session, events, log: (await readFile(join(root, "SECRET_SESSION.jsonl"), "utf8")).replaceAll(JSON.stringify(root).slice(1, -1), "FIXED_ROOT") };
}
it("maps actual parallel calls under turns, excludes all content, and preserves exact event bytes", async () => {
  const { spans, sink } = capture(); const observed = await run(s => sink.observe(s)); await sink.close();
  expect(observed.log).toBe((await run()).log);
  expect(spans.filter(s => s.name === "tool")).toHaveLength(2);
  const turn = spans.find(s => s.name === "turn")!; const root = spans.find(s => s.name === "session")!;
  for (const tool of spans.filter(s => s.name === "tool")) expect(tool.parentSpanId).toBe(turn.spanId);
  expect(turn.parentSpanId).toBe(root.spanId); expect(new Set(spans.map(s => s.traceId)).size).toBe(1);
  expect(JSON.stringify(spans)).not.toContain("SECRET"); expect(sink.retained).toEqual({ sessions: 0, activeSpans: 0 });
});
it("observes actual denials and isolates throwing/rejected observers", async () => {
  const { spans, sink } = capture(); await run(s => sink.observe(s), true); await sink.close();
  expect(spans.filter(s => s.attributes.some(a => a.key === "agentrig.outcome" && "stringValue" in a.value && a.value.stringValue === "denied"))).toHaveLength(2);
  expect((await run(() => { throw new Error("SECRET_ERROR"); })).events.at(-1)?.type).toBe("session.end");
  expect((await run((() => Promise.reject(new Error("SECRET_ERROR"))) as () => void)).events.at(-1)?.type).toBe("session.end");
});
it("bounds active sessions/spans and marks unfinished observations incomplete on close", async () => {
  const { spans, sink } = capture(); let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const session = (id: string, many = false) => ({ id, events: (async function* () {
    yield { type: "session.start", sessionId: id, seq: 0, ts: 42 } as HarnessEvent;
    if (many) for (let seq = 1; seq < 1100; seq++) yield { type: "tool.call", sessionId: id, seq, ts: 42, id: `SECRET_${seq}` } as HarnessEvent;
    await held;
  })() } as Session);
  sink.observe(session("first", true));
  await vi.waitFor(() => expect(sink.retained.activeSpans).toBe(1024));
  for (let i = 0; i < 140; i++) sink.observe(session(`session${i}`));
  expect(sink.retained.sessions).toBeLessThanOrEqual(128);
  await sink.close(); release();
  expect(sink.retained).toEqual({ sessions: 0, activeSpans: 0 });
  expect(sink.counters.dropped).toBeGreaterThan(0); expect(sink.counters.incomplete).toBe(1024);
  expect(JSON.stringify(spans)).not.toContain("SECRET");
});
it("actual post-edit checker span is nested under its mutation call", async () => {
  const root = await mkdtemp(join(tmpdir(), "otel-checker-")); roots.push(root); let turn = 0;
  const { spans, sink } = capture();
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { if (turn++ === 0) { yield { type: "tool_use", id: "edit", name: "write_file", input: { path: "target.ts", content: "const x = 1;" } }; yield { type: "stop", reason: "tool_use" }; }
      else yield { type: "stop", reason: "end_turn" }; } };
  const session = createAgent({ provider, store: new SessionStore({ root: join(root, "logs") }), repoMap: false,
    observeSession: s => sink.observe(s), systemPrompt: "fixture", permissions: new RulePolicy([{ class: "write", decision: "allow" }, { class: "exec", decision: "allow" }]),
    tools: builtinTools({ diagnostics: [{ parser: "tsc", extensions: [".ts"], executable: process.execPath, args: ["-e", "process.exitCode=0"] }] }),
  }).run("write the file and run its checker", { cwd: root });
  await session.done; for await (const _event of session.events) { /* wait for event completion */ } await sink.close();
  const calls = spans.filter(s => s.name === "tool"); expect(calls).toHaveLength(2);
  expect(calls[0]!.parentSpanId).toBe(calls[1]!.spanId); // checker completes before parent
});
it("actual cancellation exports aborted outcome without turning it into completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "otel-abort-")); roots.push(root); const { spans, sink } = capture();
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 1000 },
    async *stream(_req, signal) { entered(); await new Promise<void>(r => { signal?.addEventListener("abort", () => r(), { once: true }); });
      yield { type: "stop", reason: "end_turn" }; } };
  const session = createAgent({ provider, store: new SessionStore({ root }), tools: [], repoMap: false,
    systemPrompt: "fixture", permissions: new RulePolicy([]), observeSession: s => sink.observe(s) }).run("hold", { cwd: root });
  await ready; session.control.abort(); expect((await session.done).reason).toBe("aborted");
  for await (const _event of session.events) { /* completion barrier */ } await sink.close();
  expect(spans.find(s => s.name === "session")?.attributes).toContainEqual({ key: "agentrig.outcome", value: { stringValue: "aborted" } });
});
it("posts real OTLP JSON to the exact endpoint and returns full success", async () => {
  let path = ""; let headers: unknown;
  const { endpoint } = await collector((req, res) => { path = req.url!; headers = req.headers; req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end("{}"); }); });
  const exporter = new OtlpExporter(endpoint); exporter.push(span()); await exporter.close();
  expect(path).toBe("/exact/traces"); expect(headers).not.toHaveProperty("authorization"); expect(exporter.counters.exported).toBe(1);
});
it.each(["http://user:pass@localhost/v1/traces", "http://localhost/?secret=x", "http://localhost/#secret", "file:///tmp/secret", " http://localhost/"])("refuses endpoint %s", endpoint => {
  expect(() => otelEndpoint(endpoint)).toThrow("invalid OTLP endpoint");
});
it("never retries partial success, redirect or oversized decoded responses", async () => {
  for (const kind of ["partial", "redirect", "oversized"]) {
    let hits = 0;
    const { endpoint } = await collector((_req, res) => { hits++; res.setHeader("content-type", "application/json");
      if (kind === "redirect") { res.writeHead(302, { location: "/target" }); res.end(); }
      else res.end(kind === "partial" ? JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "SECRET_REMOTE" } }) : "x".repeat(70000)); });
    const exporter = new OtlpExporter(endpoint); exporter.push(span()); await exporter.close();
    expect(hits).toBe(1); expect(kind === "partial" ? exporter.counters.partial : exporter.counters.dropped).toBe(1);
  }
});
it("bounds Retry-After before shutdown and retries a bounded 503 only once", async () => {
  for (const after of ["3600", "0"]) {
    let hits = 0; const { endpoint } = await collector((_req, res) => { hits++; res.writeHead(503, { "retry-after": after }); res.end(); });
    const exporter = new OtlpExporter(endpoint); exporter.push(span());
    await vi.waitFor(() => expect(exporter.counters.failed).toBe(1)); // no close has started
    expect(hits).toBe(after === "0" ? 2 : 1); await exporter.close();
  }
});
it("counts in-flight payload against shared capacity and aborts a held body by total deadline", async () => {
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const { endpoint } = await collector((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); entered(); });
  const exporter = new OtlpExporter(endpoint); exporter.push(span()); await ready;
  try {
    for (let i = 0; i < OTEL_LIMITS.queuedSpans + 5; i++) exporter.push(span());
    expect(exporter.retained.spans).toBe(OTEL_LIMITS.queuedSpans); expect(exporter.counters.dropped).toBe(6);
  } finally { await exporter.close(); }
  // Abort/close owns the same total body deadline; no remote output text enters diagnostics.
  expect(exporter.retained).toEqual({ spans: 0, bytes: 0 }); expect(exporter.counters.failed).toBeGreaterThan(0);
}, 10000);
