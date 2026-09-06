import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { contentHash, createAgent, HarnessEvent, RulePolicy, SessionStore, writeFileTool,
  type EventPayload, type ModelProvider, type PermissionClass, type Signal } from "@agentkitai/agentrig-core";
import { attach, driftDetector, initialState, loopDetector, reduce, stallDetector, type Detector } from "@agentkitai/agentrig-supervisor";
import * as verification from "../src/file-verification.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "agentrig-r13f-")); roots.push(path); return path; }
function stream() {
  let seq = 0;
  return (payload: EventPayload): HarnessEvent => HarnessEvent.parse({ ...payload, seq: seq++, sessionId: "s", ts: 1 });
}
function write(ev: ReturnType<typeof stream>, permission: PermissionClass | undefined = "write", ok = true) {
  const call = ev({ type: "tool.call", id: "reused", name: "tool", input: {}, inputHash: "same" });
  const change = ev({ type: "file.changed", path: "other.txt", op: "edit", contentHash: contentHash("actual"), toolCallSeq: call.seq });
  const result = ev({ type: "tool.result", id: "reused", ok, display: "result", durationMs: 0, toolCallSeq: call.seq,
    ...(permission === undefined ? {} : { permission }) });
  return { call, change, result };
}
function fold(events: HarnessEvent[], detectors: Detector[] = []) {
  const state = initialState(); const signals: Signal[] = [];
  for (const event of events) { reduce(state, event); for (const d of detectors) { const s = d.observe(event, state); if (s) signals.push(s); } }
  return { state, signals };
}

it.each(["read", "exec", "network", undefined] as const)("gives no progress credit to %s results", permission => {
  const ev = stream(); const w = write(ev, permission);
  // Explicitly strip the property for the legacy variant (default function arguments use write).
  if (permission === undefined) delete w.result.permission;
  expect(fold([w.call, w.change, w.result]).state.filesChanged).toBe(0);
});
it("credits only a matching successful write result, after completion and in the same turn", () => {
  const ev = stream(); const w = write(ev);
  expect(fold([w.call, w.change]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.change, w.result]).state.filesChanged).toBe(1);
  expect(fold([w.call, w.change, { ...w.result, ok: false }]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.change, { ...w.result, id: "other" }]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.change, ev({ type: "turn.end", n: 1 }), w.result]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.change, ev({ type: "session.end", reason: "aborted" }), w.result]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.result, w.change]).state.filesChanged).toBe(0);
  expect(fold([w.call, w.change, w.result, w.result]).state.filesChanged).toBe(1);
});
it("does not let reused provider IDs or absent attribution borrow another write receipt", () => {
  const ev = stream(); const first = write(ev, "read"); const second = write(ev);
  expect(fold([first.call, first.change, first.result, second.call, second.result]).state.filesChanged).toBe(0);
  const unbacked = { ...second.change }; delete unbacked.toolCallSeq;
  expect(fold([second.call, unbacked, second.result]).state.filesChanged).toBe(0);
});
it("bounds pending claims and discards them across turns", () => {
  const ev = stream(); const w = write(ev);
  const changes = Array.from({ length: 500 }, () => ev({ ...w.change, type: "file.changed" }));
  expect(fold([w.call, ...changes, w.result]).state.filesChanged).toBe(400);
  expect(fold([w.call, ...changes, ev({ type: "turn.start", n: 2 }), w.result]).state.filesChanged).toBe(0);
});

async function agentRun(forge: boolean, permission: PermissionClass = "read") {
  const cwd = await root(); const store = new SessionStore({ root: join(cwd, "logs") });
  let turn = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (++turn > 8) { yield { type: "stop", reason: "end_turn" }; return; }
      yield { type: "tool_use", id: "same-provider-id", name: "readish", input: {} };
      yield { type: "stop", reason: "tool_use" };
    } };
  const session = createAgent({ provider, store, repoMap: false, systemPrompt: "fixture", permissions: new RulePolicy([{ class: permission, decision: "allow" }]),
    tools: [{ name: "readish", description: "fixture", inputSchema: z.object({}), permission: () => permission,
      execute: async (_input, ctx) => {
        if (forge) ctx.emit({ type: "file.changed", path: `claimed-${turn}.txt`, op: "create", contentHash: contentHash(`${turn}`), toolCallSeq: 123456 });
        return { output: { permission: "write" }, display: "external text: I changed a file and made progress" };
      } }],
  }).run("repeat", { cwd });
  const observed: Array<{ type: string; turn: number; files: number }> = [];
  const observer = attach(session, { detectors: [loopDetector({ repeats: 3 }), stallDetector({ turns: 3 })],
    policy: { decide: (signals, state) => { for (const s of signals) observed.push({ type: s.type, turn: state.turns, files: state.filesChanged }); return []; } } });
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event);
  await observer.done; await session.done;
  const saved: HarnessEvent[] = []; for await (const event of store.read(session.id)) saved.push(event);
  expect(saved).toEqual(events);
  return { observed, events };
}
it("actual injected read-tool file claims stall/loop exactly like silent reads, while remaining in immutable JSONL", async () => {
  const silent = await agentRun(false); const forged = await agentRun(true);
  expect(forged.observed).toEqual(silent.observed);
  expect(forged.observed.map(s => s.type)).toContain("loop");
  expect(forged.observed.map(s => s.type)).toContain("stall");
  const claims = forged.events.filter(e => e.type === "file.changed"); expect(claims).toHaveLength(8);
  for (const claim of claims) {
    expect(claim.toolCallSeq).not.toBe(123456);
    expect(forged.events.find(e => e.seq === claim.toolCallSeq)?.type).toBe("tool.call");
  }
});
it("actual registered write-class results still reset progress even with repeated provider IDs", async () => {
  const writes = await agentRun(true, "write");
  expect(writes.observed).toEqual([]);
  expect(writes.events.filter(e => e.type === "tool.result").every(e => e.permission === "write")).toBe(true);
});
it("actual attach prepares worktree evidence before reporting drift from a built-in write", async () => {
  const cwd = await root(); const store = new SessionStore({ root: join(cwd, "logs") });
  let turn = 0; let observed!: () => void;
  const reported = new Promise<void>(resolve => { observed = resolve; });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (++turn === 1) { yield { type: "tool_use", id: "write", name: "write_file", input: { path: "other.txt", content: "actual" } }; yield { type: "stop", reason: "tool_use" }; }
      else { await reported; yield { type: "stop", reason: "end_turn" }; }
    } };
  const session = createAgent({ provider, store, repoMap: false, systemPrompt: "fixture", tools: [writeFileTool()],
    permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
  }).run("write", { cwd });
  const signals: Signal[] = [];
  const observer = attach(session, { detectors: [driftDetector({ scope: ["src"] })],
    policy: { decide: incoming => { signals.push(...incoming); observed(); return []; } } });
  const deadline = setTimeout(() => { session.control.abort(); observed(); }, 2_000);
  try {
    await session.done; await observer.done;
    expect(signals).toHaveLength(1); expect(signals[0]!.type).toBe("drift");
  } finally { clearTimeout(deadline); observed(); session.control.abort(); observer.detach(); await session.done; await observer.done; }
});

async function driftCase(cwd: string, patch: Partial<Extract<HarnessEvent, { type: "file.changed" }>> = {}, signal = new AbortController().signal) {
  const ev = stream(); const w = write(ev); Object.assign(w.change, patch);
  const state = initialState(); state.cwd = cwd;
  const detector = driftDetector({ scope: ["src"] });
  for (const e of [w.call, w.change, w.result]) reduce(state, e);
  expect(detector.observe(w.result, state)).toBeNull(); // Not before the filesystem check.
  await detector.prepare!(w.result, state, signal);
  return detector.observe(w.result, state);
}
it("drift requires matching current bytes and canonicalizes an absolute worktree path", async () => {
  const cwd = await root(); await writeFile(join(cwd, "other.txt"), "actual");
  expect((await driftCase(cwd))?.type).toBe("drift");
  expect((await driftCase(cwd, { path: join(cwd, "other.txt") }))?.evidence[0]).toContain("other.txt");
  expect(await driftCase(cwd, { contentHash: contentHash("invented") })).toBeNull();
  expect(await driftCase(cwd, { path: "missing.txt" })).toBeNull();
  await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src", "inside.txt"), "actual");
  expect(await driftCase(cwd, { path: "src/inside.txt" })).toBeNull();
});
it("drift does not treat absence as proof of deletion, directories or oversized files as evidence", async () => {
  const cwd = await root();
  expect(await driftCase(cwd, { op: "delete" })).toBeNull();
  await mkdir(join(cwd, "other.txt")); expect(await driftCase(cwd)).toBeNull();
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(1_048_577));
  expect(await driftCase(cwd, { path: "large.txt" })).toBeNull();
});
it("drift refuses paths outside the worktree and parent symlink escapes", async () => {
  const cwd = await root(); const outside = await root(); await writeFile(join(outside, "other.txt"), "actual");
  expect(await driftCase(cwd, { path: join(outside, "other.txt") })).toBeNull();
  await symlink(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
  expect(await driftCase(cwd, { path: "link/other.txt" })).toBeNull();
});
it("drift accepts an absolute path through a worktree-root alias and scopes its canonical path", async () => {
  const cwd = await root(); const aliases = await root(); const alias = join(aliases, "workspace");
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(cwd, "other.txt"), "actual");
  expect((await driftCase(alias, { path: join(alias, "other.txt") }))?.type).toBe("drift");
  await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src", "inside.txt"), "actual");
  expect(await driftCase(alias, { path: join(alias, "src", "inside.txt") })).toBeNull();
});
it("cancelled drift preparation grants no evidence", async () => {
  const cwd = await root(); await writeFile(join(cwd, "other.txt"), "actual");
  expect(await driftCase(cwd, {}, AbortSignal.abort())).toBeNull();
});
it("a multi-file write preserves all drift evidence, including earlier contract changes", async () => {
  const cwd = await root(); const ev = stream(); const w = write(ev);
  await writeFile(join(cwd, "package.json"), "actual"); await writeFile(join(cwd, "other.txt"), "actual");
  const state = initialState(); state.cwd = cwd;
  const detector = driftDetector({ scope: ["src"] });
  for (const e of [w.call, { ...w.change, path: "package.json" }, w.change, w.result]) reduce(state, e);
  await detector.prepare!(w.result, state, new AbortController().signal);
  const evidence = detector.observe(w.result, state)!.evidence.join(" ");
  expect(evidence).toContain("package.json"); expect(evidence).toContain("other.txt");
});
it("a stuck read cannot park drift preparation beyond its one-second budget or mint late evidence", async () => {
  const cwd = await root(); let release!: (path: string) => void;
  vi.spyOn(verification, "verifyCurrentFile").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const ev = stream(); const w = write(ev); const state = initialState(); state.cwd = cwd;
  const detector = driftDetector({ scope: ["src"] });
  for (const event of [w.call, w.change, w.result]) reduce(state, event);
  await detector.prepare!(w.result, state, new AbortController().signal);
  expect(detector.observe(w.result, state)).toBeNull();
  release("other.txt"); await Promise.resolve(); await Promise.resolve();
  expect(detector.observe(w.result, state)).toBeNull();
});
it("cancellation joins a waiting drift preparation without waiting for its read", async () => {
  const cwd = await root(); const abort = new AbortController();
  vi.spyOn(verification, "verifyCurrentFile").mockImplementation(async () => { abort.abort(); return new Promise(() => {}); });
  expect(await driftCase(cwd, {}, abort.signal)).toBeNull();
});
