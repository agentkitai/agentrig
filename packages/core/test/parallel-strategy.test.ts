import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, parallel, RulePolicy, SessionStore, writeFileTool, editFileTool,
  type AgentConfig, type ModelEvent, type ModelProvider, type Session, type Tool } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
type Input = { path: string; label: string; kind: "read" | "write" | "exec" };
async function fixture(calls: Input[], overrides: Partial<AgentConfig> = {}, configure?: (root: string) => Promise<void>, tweak?: (tool: Tool<Input>) => void) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-parallel-")); roots.push(root);
  await mkdir(join(root, "dir")); await writeFile(join(root, "a"), "a"); await writeFile(join(root, "b"), "b");
  await configure?.(root);
  const entered = calls.map(latch); const gates = calls.map(latch); const described = calls.map(latch);
  const stages: string[] = []; const paths: string[] = []; let turn = 0;
  const provider: ModelProvider = { id: "parallel", model: "inert", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 },
    async *stream(): AsyncIterable<ModelEvent> {
      if (turn++ === 0) for (const input of calls) yield { type: "tool_use", id: input.label, name: "probe", input };
      yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
    } };
  const tool: Tool<Input> = { name: "probe", description: "trusted fixture", inputSchema: z.object({ path: z.string(), label: z.string(), kind: z.enum(["read", "write", "exec"]) }),
    permission: input => input.kind, effects: input => input.kind === "read" ? "read-only" : "workspace",
    paths: input => { paths.push(input.path); described[calls.findIndex(call => call.label === input.label)]!.release(); return [input.path]; },
    async execute(input, context) {
      const index = calls.findIndex(call => call.label === input.label);
      stages.push(`start:${input.label}`); entered[index]!.release(); await gates[index]!.promise;
      const path = join(context.cwd, input.path);
      if (input.kind === "write") await writeFile(path, input.label);
      const output = input.kind === "read" ? await readFile(path, "utf8") : input.label;
      stages.push(`end:${input.label}`); return { output, display: output };
    } };
  tweak?.(tool);
  const store = new SessionStore({ root: join(root, "logs") });
  const config: AgentConfig = { provider, store, systemPrompt: "inert scheduling fixture", tools: [tool], permissions: new RulePolicy([{ decision: "allow" }]), repoMap: false,
    turnStrategy: parallel(), ...overrides };
  const session = createAgent(config).run("exercise local declared file operations", { cwd: root });
  const finished = (async () => { const events = []; for await (const event of session.events) events.push(event); return { events, summary: await session.done }; })();
  return { root, entered, gates, described, stages, paths, session, finished, store };
}
const call = (path: string, label: string, kind: Input["kind"] = "read"): Input => ({ path, label, kind });

it.each(["read", "write"] as const)("runs disjoint %s bodies in one controlled tick, retaining result/log order", async kind => {
  const f = await fixture([call("a", "one", kind), call("b", "two", kind)]);
  try {
    await Promise.all(f.entered.map(entry => entry.promise));
    expect(f.stages).toEqual(["start:one", "start:two"]);
    // Both already entered before a single shared clock tick releases either body.
    vi.useFakeTimers(); setTimeout(() => f.gates.forEach(gate => gate.release()), 10);
    await vi.advanceTimersByTimeAsync(10); vi.useRealTimers();
    const { events, summary } = await f.finished; expect(summary.reason).toBe("done");
    expect(events.map(event => event.seq)).toEqual(events.map((_event, index) => index));
    expect(await readFile(join(f.store.root, `${f.session.id}.jsonl`), "utf8")).toBe(events.map(event => JSON.stringify(event) + "\n").join(""));
    const snapshot = await f.store.readSnapshot(f.session.id);
    const results = snapshot!.messages.flatMap(message => message.content).filter(block => block.type === "tool_result");
    expect(results.map(result => result.toolUseId)).toEqual(["one", "two"]);
    if (kind === "write") expect(await Promise.all([readFile(join(f.root, "a"), "utf8"), readFile(join(f.root, "b"), "utf8")])).toEqual(["one", "two"]);
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it.each([
  ["same write", call("a", "one", "write"), call("a", "two", "write")],
  ["read/write", call("a", "one"), call("a", "two", "write")],
  ["case alias", call("a", "one", "write"), call("A", "two", "write")],
  ["exclusive exec", call("a", "one", "exec"), call("b", "two")],
  ["directory ancestor", call("a", "one", "write"), call(".", "two")],
  ["missing parent", call("a", "one"), call("missing/new", "two", "write")],
] as const)("serializes %s and does not let a later independent call bypass the barrier", async (_label, first, second) => {
  const f = await fixture([first, second, call("b", "three")]);
  try {
    await f.entered[0]!.promise; await f.described[1]!.promise;
    expect(f.stages).toEqual(["start:one"]); expect(f.paths).toHaveLength(2);
    // Keep the first actual I/O body live while later admission can finish classifying.
    // Releasing it at paths() time would let a broken classifier accidentally look serial.
    f.gates[1]!.release(); f.gates[2]!.release();
    await new Promise<void>(resolve => setTimeout(resolve, 100)); f.gates[0]!.release();
    expect((await f.finished).summary.reason).toBe("done");
    expect(f.stages.indexOf("start:two")).toBeGreaterThan(f.stages.indexOf("end:one"));
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it.each(["unknown effect", "empty paths", "too many paths", "long path", "background"])("keeps %s exclusive rather than guessing independence", async kind => {
  const f = await fixture([call("a", "one"), call("b", "two")], {}, undefined, tool => {
    if (kind === "unknown effect") delete tool.effects;
    else if (kind === "background") tool.hasBackgroundWork = () => true;
    else { const paths = tool.paths!; tool.paths = input => {
      const actual = paths(input); return kind === "empty paths" ? [] : kind === "too many paths" ? Array(65).fill("a") : ["x".repeat(4097)];
    }; }
  });
  try { await f.entered[0]!.promise;
    if (kind !== "background") await f.described[1]!.promise;
    expect(f.stages).toEqual(["start:one"]); f.gates[0]!.release(); await f.entered[1]!.promise; f.gates[1]!.release();
    await f.finished; expect(f.stages.indexOf("start:two")).toBeGreaterThan(f.stages.indexOf("end:one"));
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it("executes actual built-in writes concurrently to new files under an existing parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-parallel-builtin-")); roots.push(root);
  const entered = [latch(), latch()]; const gate = latch(); const builtin = writeFileTool(); let turn = 0;
  const provider: ModelProvider = { id: "parallel", model: "inert", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 10000 },
    async *stream() { if (turn++ === 0) for (const path of ["a", "b"]) yield { type: "tool_use" as const, id: path, name: "write_file", input: { path, content: path } };
      yield { type: "stop" as const, reason: turn === 1 ? "tool_use" as const : "end_turn" as const }; } };
  const session = createAgent({ provider, systemPrompt: "inert", repoMap: false, store: new SessionStore({ root: join(root, "logs") }),
    permissions: new RulePolicy([{ decision: "allow" }]), turnStrategy: parallel(), tools: [{ ...builtin, async execute(input, context) {
      entered[input.path === "a" ? 0 : 1]!.release(); await gate.promise; return builtin.execute(input, context);
    } }] }).run("write a and b", { cwd: root });
  try { await Promise.all(entered.map(entry => entry.promise)); gate.release(); expect((await session.done).reason).toBe("done");
    expect(await Promise.all([readFile(join(root, "a"), "utf8"), readFile(join(root, "b"), "utf8")])).toEqual(["a", "b"]);
    const events = []; for await (const event of session.events) events.push(event);
    expect(events.filter(event => event.type === "file.changed").map(event => event.path).sort()).toEqual(["a", "b"]);
  } finally { gate.release(); await session.done; }
});

it.each(["hardlink", "symlink"] as const)("serializes existing %s aliases", async kind => {
  const f = await fixture([call("a", "one", "write"), call("alias", "two", "write")], {}, async root => {
    if (kind === "hardlink") await link(join(root, "a"), join(root, "alias"));
    else await symlink(join(root, "a"), join(root, "alias"), "file");
  });
  try { await f.entered[0]!.promise; await f.described[1]!.promise; expect(f.stages).toEqual(["start:one"]);
    f.gates[1]!.release(); await new Promise<void>(resolve => setTimeout(resolve, 100)); f.gates[0]!.release();
    expect((await f.finished).summary.reason).toBe("done");
    expect(f.stages.indexOf("start:two")).toBeGreaterThan(f.stages.indexOf("end:one"));
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it("derives paths once from the validated hook-modified input and keeps hooks exclusive", async () => {
  const hookInputs: string[] = [];
  const f = await fixture([call("a", "one"), call("b", "two")], { hooks: [{ point: "pre_tool", handler(context) {
    const input = context.tool!.input as Input; hookInputs.push(input.path); return { action: "modify", patch: { path: "a" } };
  } }] });
  try { await f.entered[0]!.promise; expect(f.paths).toEqual(["a"]); expect(hookInputs).toEqual(["a"]);
    f.gates[0]!.release(); await f.entered[1]!.promise; expect(f.paths).toEqual(["a", "a"]); expect(hookInputs).toEqual(["a", "b"]);
    f.gates[1]!.release(); expect((await f.finished).summary.reason).toBe("done");
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it("serializes actual permission handlers while allowing approved independent bodies to overlap", async () => {
  const asks = [latch(), latch()]; const answers = [latch(), latch()]; let count = 0;
  const f = await fixture([call("a", "one"), call("b", "two")], { permissions: new RulePolicy([]), async onAsk() {
    const index = count++; asks[index]!.release(); await answers[index]!.promise; return "allow";
  } });
  try { await asks[0]!.promise; expect(count).toBe(1); answers[0]!.release(); await f.entered[0]!.promise;
    await asks[1]!.promise; expect(f.stages).toEqual(["start:one"]); answers[1]!.release(); await f.entered[1]!.promise;
    f.gates.forEach(gate => gate.release()); expect((await f.finished).summary.reason).toBe("done");
  } finally { answers.forEach(answer => answer.release()); f.gates.forEach(gate => gate.release()); await f.finished; }
});

it("bounds the live pool and stops queued bodies on cancellation", async () => {
  const f = await fixture([call("a", "one"), call("b", "two"), call("a", "three")], { turnStrategy: parallel({ maxConcurrency: 2 }) });
  try { await Promise.all(f.entered.slice(0, 2).map(entry => entry.promise)); expect(f.paths).toHaveLength(2);
    f.session.control.abort(); f.gates.forEach(gate => gate.release());
    expect((await f.finished).summary.reason).toBe("aborted"); expect(f.stages).not.toContain("start:three");
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});

it("validates pool bounds and declares built-in write/edit effects explicitly", () => {
  for (const maxConcurrency of [0, 17, 1.5, NaN, Infinity]) expect(() => parallel({ maxConcurrency })).toThrow("1 to 16");
  expect(writeFileTool().effects).toBe("workspace"); expect(editFileTool().effects).toBe("workspace");
});

it("joins an already-started pipeline before surfacing a later fatal policy rejection", async () => {
  const rejected = latch(); let settled = false;
  const f = await fixture([call("a", "one"), call("b", "two"), call("a", "three")], {
    permissions: { async decide(request) {
      if ((request.input as Input).label === "two") { rejected.release(); throw new Error("policy fixture failed"); }
      return "allow";
    } }, turnStrategy: parallel({ maxConcurrency: 2 }),
  });
  void f.finished.then(() => { settled = true; });
  try { await f.entered[0]!.promise; await rejected.promise; await Promise.resolve(); expect(settled).toBe(false);
    f.gates[0]!.release(); const result = await f.finished; expect(result.summary.reason).toBe("error");
    expect(f.stages).toEqual(["start:one", "end:one"]);
    expect(result.events.at(-1)?.type).toBe("session.end");
    expect(result.events.some(event => event.type === "error" && event.message === "policy fixture failed" && event.fatal)).toBe(true);
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
});
