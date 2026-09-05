import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { isValidSessionId } from "@agentkitai/agentrig-core";
import { FileMemoryStore, FileRawStore, addPin, applyPinChecks, factLines, findingCount, ingestSession, memoryTools, readPins, recheckPins, renderReport, runDream,
  recheckStoredPins, writePins, type MemoryBackend, type Pin } from "@agentkitai/agentrig-memory";

let root: string;
let store: FileMemoryStore;
let logPath: string;
const path = "concepts/shared.md";
const sourcePath = "sources/session-s1.md";
const events = [{ type: "session.start", task: "retain facts", cwd: "/fixture" },
  { type: "tool.result", ok: true, display: "original evidence" }];
const page = (body: string) => ({ path, body, frontmatter: { type: "concept" as const, slug: "shared",
  aliases: ["durable alias"], sources: ["session:human"], updated: "2026-09-05", confidence: "medium" as const } });
const pin = (claim = "original evidence"): Pin => ({ page: path, kind: "addition", claim, anchor: "",
  provenance: "human", created: "2026-09-05", status: "active" });
const gate = () => Promise.withResolvers<void>();
function provider(text = "original evidence", wait?: () => Promise<void>): ModelProvider & { calls: number } {
  const result: ModelProvider & { calls: number } = {
    id: "fixture", model: "fixture", calls: 0,
    capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      result.calls++;
      await wait?.();
      yield { type: "text_delta", text: JSON.stringify({ summary: text,
        facts: [{ pageType: "concept", slug: "shared", tag: "observed", text }] }) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
  return result;
}
const log = (items: unknown[]) => writeFile(logPath, items.map(item => JSON.stringify(item)).join("\n") + "\n");
const ingest = (p = provider(), extra: Partial<Parameters<typeof ingestSession>[0]> = {}) =>
  ingestSession({ store, provider: p, sessionId: "s1", logPath, ...extra });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-ingest-persistence-"));
  store = new FileMemoryStore({ root: join(root, "wiki") });
  await store.init();
  logPath = join(root, "session.jsonl");
  await log(events);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("skips a strictly shorter raw capture without provider calls or page changes", async () => {
  await ingest();
  const before = await readFile(join(store.root, sourcePath), "utf8");
  const chronology = await readFile(join(store.root, "log.md"), "utf8");
  await log(events.slice(0, 1));
  const p = provider("stale replacement");
  expect(await ingest(p)).toMatchObject({ skipped: true, factCount: 0, pagesWritten: [] });
  expect(p.calls).toBe(0);
  expect(await readFile(join(store.root, sourcePath), "utf8")).toBe(before);
  expect(await readFile(join(store.root, "log.md"), "utf8")).toBe(chronology);
});

it("uses raw event prefixes when canonical messages replace streamed transcript fallback", async () => {
  const start = [...events, { type: "model.delta", text: "draft wording" }];
  await log(start); await ingest(provider("first narrative"));
  await log([...start, { type: "message.append", message: { role: "assistant",
    content: [{ type: "text", text: "canonical wording" }] } }]);
  expect(await ingest(provider("second narrative"))).toMatchObject({ supersededPrevious: true, skipped: false });
  const body = (await store.read(sourcePath))!.body;
  expect(body).toContain("first narrative"); expect(body).toContain("second narrative");
  await log(start);
  expect((await ingest()).skipped).toBe(true);
});

it("reprocesses old H3 captures once to establish raw-prefix evidence", async () => {
  await ingest();
  await store.update(sourcePath, current => ({ ...current!, body: current!.body.replace(/^<!-- ingest:events-v1=.* -->\n?/m, "") }));
  const p = provider();
  expect((await ingest(p)).skipped).toBe(false); expect(p.calls).toBeGreaterThan(0);
  expect((await ingest()).skipped).toBe(true);
});

it("does not discard a different shorter capture", async () => {
  await ingest();
  await log([{ type: "tool.result", ok: true, display: "different event" }]);
  expect(await ingest(provider("unique shorter narrative"))).toMatchObject({ skipped: false, supersededPrevious: false });
  const body = (await store.read(sourcePath))!.body;
  expect(body).toContain("original evidence"); expect(body).toContain("unique shorter narrative");
});

it("deduplicates summaries and source facts within a single distillation", async () => {
  const p: ModelProvider = { ...provider(), async *stream() {
    yield { type: "text_delta", text: JSON.stringify({ summary: "shared narrative", facts: [
      { pageType: "source", slug: "ignored", tag: "observed", text: "shared narrative" },
      { pageType: "source", slug: "ignored", tag: "observed", text: "shared narrative" },
    ] }) };
  } };
  await ingest(p);
  expect((await store.read(sourcePath))!.body.split("shared narrative")).toHaveLength(2);
});

it("rejects malformed capture metadata before distillation or page mutation", async () => {
  await ingest();
  await store.update(sourcePath, current => ({ ...current!, body: current!.body.replace(/^<!-- ingest:events-v1=.* -->/m,
    "<!-- ingest:events-v1=not-json -->") }));
  const before = (await store.read(sourcePath))!.version;
  const p = provider();
  await expect(ingest(p)).rejects.toThrow(); expect(p.calls).toBe(0);
  expect((await store.read(sourcePath))!.version).toBe(before);
});

it("merges source edits made while a provider is running", async () => {
  const started = gate(); const release = gate();
  const pending = ingest(provider("distilled", async () => { started.resolve(); await release.promise; }));
  void pending.catch(() => {});
  try {
    await started.promise;
    await store.write(sourcePath, { ...page("human addition"), path: sourcePath,
      frontmatter: { ...page("").frontmatter, type: "source", slug: "session-s1" } });
  } finally { release.resolve(); }
  await pending;
  const current = (await store.read(sourcePath))!;
  expect(current.body).toContain("human addition"); expect(current.body).toContain("distilled");
  expect(current.frontmatter.aliases).toContain("durable alias");
  expect(current.frontmatter.sources).toEqual(expect.arrayContaining(["session:human", "session:s1"]));
});

it("serializes same-session ingests without blocking another session's provider", async () => {
  const started = gate(); const release = gate();
  const first = ingest(provider("first", async () => { started.resolve(); await release.promise; }));
  void first.catch(() => {});
  try {
    await started.promise;
    const duplicate = provider("duplicate");
    await expect(ingest(duplicate, { lockTimeoutMs: 30 })).rejects.toThrow("timed out waiting for memory lock");
    await expect(ingest(duplicate, { sessionId: "S1", lockTimeoutMs: 30 })).rejects.toThrow("timed out waiting for memory lock");
    expect(duplicate.calls).toBe(0);
    expect((await ingest(provider("other session"), { sessionId: "s2" })).skipped).toBe(false);
  } finally { release.resolve(); }
  await first;
  expect((await ingest()).skipped).toBe(true);
  expect((await store.read(path))!.body).toContain("other session");
});

it.each(["", "../escape", "a/b", "x".repeat(129)])("rejects invalid ingest session ids before provider work: %j", async sessionId => {
  const p = provider();
  await expect(ingest(p, { sessionId })).rejects.toThrow("invalid ingest session id");
  expect(p.calls).toBe(0);
  expect(await store.read(sourcePath)).toBeNull();
});

it("does not mark an interrupted local ingest complete and safely retries its partial pages", async () => {
  const original = store.upsertIndex.bind(store);
  const fault = vi.spyOn(store, "upsertIndex").mockImplementation(async row => {
    if (row.type === "concept") throw new Error("interrupted index write");
    await original(row);
  });
  await expect(ingest()).rejects.toThrow("interrupted index write");
  expect((await store.read(sourcePath))!.body).toContain("<!-- ingest:pending -->");
  expect((await store.read(sourcePath))!.body).not.toContain("ingest:events-v1=");
  expect((await store.read(path))!.body).toContain("original evidence");
  fault.mockRestore();
  expect((await ingest()).skipped).toBe(false);
  expect((await store.read(path))!.body.split("original evidence")).toHaveLength(2);
  expect((await store.read(sourcePath))!.body).not.toContain("<!-- ingest:pending -->");
  expect((await ingest()).skipped).toBe(true);
});

it("does not hide malformed source pages or pin files", async () => {
  await writeFile(join(store.root, sourcePath), "invalid page");
  const p = provider();
  await expect(ingest(p)).rejects.toThrow("missing frontmatter"); expect(p.calls).toBe(0);
  await rm(join(store.root, sourcePath));
  await writeFile(join(store.root, "pins.json"), "invalid json");
  await expect(ingest()).rejects.toThrow();
  expect((await store.read(sourcePath))!.body).toContain("<!-- ingest:pending -->");
  expect(await readFile(join(store.root, "pins.json"), "utf8")).toBe("invalid json");
});

it("annotates the locked current page and deduplicates previously annotated facts", async () => {
  let annotating = false; let insideUpdate = false;
  let stale: Awaited<ReturnType<typeof store.read>>;
  const read = store.read.bind(store); const update = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementation(async (...args) => {
    insideUpdate = true;
    try { return await update(...args); } finally { insideUpdate = false; }
  });
  vi.spyOn(store, "read").mockImplementation(async target =>
    annotating && target === path && !insideUpdate ? stale : read(target));
  const backend: MemoryBackend = { id: "fixture", recall: async () => [], promote: async () => {},
    onIngest: async () => {
      stale = await read(path);
      await new FileMemoryStore({ root: store.root }).update(path, current => ({ ...current!,
        body: current!.body + "human concurrent fact\n",
        frontmatter: { ...current!.frontmatter, aliases: ["new alias"] } }));
      annotating = true;
      return [{ factText: "original evidence", memoryId: "m1" }];
    } };
  await ingest(provider(), { backend });
  annotating = false;
  const current = (await read(path))!;
  expect(current.body).toContain("human concurrent fact");
  expect(current.body).toContain("session:s1, fixture:m1");
  expect(current.frontmatter.aliases).toContain("new alias");
  await log([...events, { type: "session.end", reason: "done" }]);
  await ingest();
  expect((await read(path))!.body.split("original evidence")).toHaveLength(2);
});

it.each(["\n", "\n\n", "\r\n\r\n"])("normalizes fact line breaks %j while preserving literal punctuation and provenance", async separator => {
  const text = `literal [x] + $value${separator}second line (details)`;
  const normalized = "literal [x] + $value second line (details)";
  const backend: MemoryBackend = { id: "fixture", recall: async () => [], promote: async () => {},
    onIngest: async facts => [{ factText: facts[0]!.text, memoryId: "m$1" }] };
  await ingest(provider(text), { backend });
  expect((await store.read(path))!.body).toContain(`${normalized} (session:s1, fixture:m$1)`);
  await log([...events, { type: "session.end", reason: "done" }]);
  await ingest(provider(text), { backend });
  expect((await store.read(path))!.body.split(normalized)).toHaveLength(2);
  expect((await store.read(sourcePath))!.body.split(normalized)).toHaveLength(2);
  expect(factLines((await store.read(path))!.body)).toMatchObject([{ text: `${normalized} (session:s1, fixture:m$1)`, refs: ["session:s1", "fixture:m$1"] }]);
});

it("preserves concurrent pin additions and refuses stale pin/page checks", async () => {
  await store.write(path, page("other content"));
  await Promise.all(Array.from({ length: 12 }, (_, i) => addPin(store.root, pin(`claim ${i}`))));
  expect(await readPins(store.root)).toHaveLength(12);
  const old = (await readPins(store.root))[0]!;
  const checks = await recheckPins(store, [old]);
  await addPin(store.root, { ...old, anchor: "new human anchor" });
  expect(await applyPinChecks(store.root, checks)).toEqual({ applied: 0, skipped: 1 });
  expect((await readPins(store.root)).find(p => p.claim === old.claim)).toMatchObject({ anchor: "new human anchor", status: "active" });
  const fresh = await readPins(store.root);
  const snapshot = await recheckPins(store, fresh);
  await store.write(path, page(fresh.map(p => p.claim).join("\n")));
  expect(await applyPinChecks(store.root, snapshot)).toEqual({ applied: 0, skipped: 12 });
  expect((await readPins(store.root)).every(p => p.status === "active")).toBe(true);
  await writePins(store.root, []);
  expect(await applyPinChecks(store.root, await recheckPins(store, [old]))).toEqual({ applied: 0, skipped: 1 });
  expect(await readPins(store.root)).toEqual([]);
});

it("rechecks current pins under the mutation lock and leaves malformed pages unchanged", async () => {
  await store.write(path, page("other content")); await addPin(store.root, pin());
  expect((await recheckStoredPins(store))[0]).toMatchObject({ status: "conflict" });
  expect((await readPins(store.root))[0]!.status).toBe("conflict");
  await writeFile(join(store.root, path), "malformed");
  await expect(recheckStoredPins(store)).rejects.toThrow("missing frontmatter");
  expect((await readPins(store.root))[0]!.status).toBe("conflict");
});

it("reports pin conflicts for filed analysis replacements as well as memory_write", async () => {
  const tool = memoryTools({ store }).find(t => t.name === "memory_file_analysis")!;
  const ctx = { cwd: root, sessionId: "s1", signal: new AbortController().signal, emit() {} };
  await tool.execute({ slug: "shared", body: "original evidence" }, ctx);
  await addPin(store.root, { ...pin(), page: "analyses/shared.md" });
  const version = (await store.read("analyses/shared.md"))!.version;
  const result = await tool.execute({ slug: "shared", body: "unrelated replacement", if_version: version }, ctx);
  expect(result.isError).toBe(true);
  expect(result.output).toMatchObject({ committed: true, pinConflicts: [{ claim: "original evidence" }] });
  expect((await readPins(store.root))[0]!.status).toBe("conflict");
});

it.each(["", "# Lo", "# Log\n\nAppend-only chrono", "# Log\n\nAppend-only chrono\n## existing entry\n",
  "## existing entry", "# Other heading\n## existing entry", "# Log\nCustom chronology\n## existing entry\n"])
("recovers initialized log fragments and retains existing entries: %j", async text => {
  await writeFile(join(store.root, "log.md"), text);
  await store.appendLog("## new entry");
  const result = await readFile(join(store.root, "log.md"), "utf8");
  expect(result).toMatch(/^# Log\n\nAppend-only chronology of ingests, dreams, and corrections\.\n/);
  expect(result).toContain("\n## new entry\n");
  if (text.includes("## existing entry")) expect(result.match(/## existing entry/g)).toHaveLength(1);
  if (text.includes("# Other heading")) expect(result).toContain("# Other heading");
  if (text.includes("Custom chronology")) expect(result).toContain("Custom chronology");
});

function launchWorkers(mode = "distinct") {
  return ["first", "second"].map(name => {
    const child = fork(new URL("./fixtures/ingest-writer.mjs", import.meta.url), [store.root, logPath, name, mode],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = ""; child.stderr!.on("data", data => { errors += data; });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
      child.once("exit", code => reject(new Error(`worker ${name}: ${code}: ${errors}`)));
    });
    const done = new Promise<{ calls: number; skipped: number }>((resolve, reject) => {
      child.on("message", message => {
        const msg = message as { done?: boolean; error?: string; calls: number; skipped: number };
        if (msg.done) resolve(msg); if (msg.error) reject(new Error(msg.error));
      });
      child.once("error", reject); child.once("exit", code => reject(new Error(`worker ${name}: ${code}: ${errors}`)));
    });
    void done.catch(() => {});
    return { child, ready, done, exited };
  });
}

it("conserves shared facts, sources and pins across actual ingest processes", async () => {
  const workers = launchWorkers();
  try {
    await Promise.all(workers.map(w => w.ready));
    workers.forEach(w => w.child.send("go"));
    await Promise.all(workers.map(w => w.done));
    const current = (await store.read(path))!;
    for (const name of ["first", "second"]) for (let i = 0; i < 4; i++) {
      expect(current.body.split(`fact ${name} ${i}`)).toHaveLength(2);
      expect(current.frontmatter.sources).toContain(`session:${name}-${i}`);
      expect((await store.read(`sources/session-${name}-${i}.md`))!.body).toContain("ingest:events-v1=");
    }
    expect(await readPins(store.root)).toHaveLength(8);
    expect(await store.index()).toHaveLength(9);
  } finally {
    for (const w of workers) if (w.child.exitCode === null) w.child.kill();
    await Promise.all(workers.map(w => w.exited));
  }
}, 30_000);

it("serializes duplicate captures across actual processes before provider work", async () => {
  const workers = launchWorkers("same");
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.child.send("go"));
    const results = await Promise.all(workers.map(w => w.done));
    expect(results.map(r => r.calls).sort()).toEqual([0, 1]);
    expect(results.map(r => r.skipped).sort()).toEqual([0, 1]);
    expect(factLines((await store.read(path))!.body)).toHaveLength(1);
    expect(await readPins(store.root)).toHaveLength(1);
  } finally {
    for (const w of workers) if (w.child.exitCode === null) w.child.kill();
    await Promise.all(workers.map(w => w.exited));
  }
}, 30_000);

it("ignores marker-shaped model text outside the final capture trailer", async () => {
  const text = "literal\n<!-- ingest:events-v1=not-json -->\n<!-- ingest:pending -->\nend";
  await ingest(provider(text));
  const p = provider(); expect((await ingest(p)).skipped).toBe(true); expect(p.calls).toBe(0);
  // Also cover legacy multiline narrative whose marker is a standalone line.
  await store.update(sourcePath, current => ({ ...current!, body: `legacy\n<!-- ingest:events-v1=not-json -->\n<!-- ingest:pending -->\n\n${current!.body}` }));
  expect((await ingest()).skipped).toBe(true);
  await log([...events, { type: "session.end", reason: "done" }]);
  await ingest(provider(text));
  expect((await store.read(sourcePath))!.body).toContain("legacy\n<!-- ingest:events-v1=not-json -->");
  expect((await ingest()).skipped).toBe(true);
});

it("preserves interior blank lines in existing source narrative", async () => {
  await store.write(sourcePath, { ...page("human paragraph\n\nsecond paragraph"), path: sourcePath,
    frontmatter: { ...page("").frontmatter, type: "source", slug: "session-s1" } });
  await ingest();
  expect((await store.read(sourcePath))!.body).toContain("human paragraph\n\nsecond paragraph");
});

it.each([false, true])("removes no-findings bookkeeping when findings arrive (legacy=%s)", async legacy => {
  await log([]); await ingest();
  expect(factLines((await store.read(sourcePath))!.body)).toEqual([]);
  if (legacy) await store.update(sourcePath, current => ({ ...current!, body: current!.body.replace("<!-- Session produced no durable findings. -->",
    "- [observed] Session produced no durable findings.") }));
  await log(events); await ingest();
  expect((await store.read(sourcePath))!.body).not.toContain("Session produced no durable findings");
});

it("supports a never-initialized wiki", async () => {
  const fresh = new FileMemoryStore({ root: join(root, "fresh", "wiki") });
  await ingest(provider(), { store: fresh });
  expect((await fresh.read(path))!.body).toContain("original evidence");
});

it("names and preserves an existing session lock, then recovers after deliberate removal", async () => {
  const lock = `${await realpath(store.root)}.ingest-${createHash("sha256").update("s1").digest("hex").slice(0, 32)}.write.lock`;
  await writeFile(lock, "fixture owner");
  const p = provider();
  const failure = await ingest(p, { lockTimeoutMs: 20 }).catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("another ingest of this session may be running");
  expect((failure as Error).message).toContain(lock);
  expect(await readFile(lock, "utf8")).toBe("fixture owner"); expect(p.calls).toBe(0);
  await rm(lock); // This test created the exact fixture; no live owner exists.
  await ingest();
  expect((await readdir(root)).filter(name => name.endsWith(".write.lock"))).toEqual([]);
  await expect(ingest(provider("unused", async () => { throw new Error("provider failed"); }), { sessionId: "fails" }))
    .rejects.toThrow("provider failed");
  expect((await readdir(root)).filter(name => name.endsWith(".write.lock"))).toEqual([]);
});

it("cancels a session-lock wait without disturbing the live owner", async () => {
  const started = gate(); const release = gate(); const controller = new AbortController();
  const first = ingest(provider("first", async () => { started.resolve(); await release.promise; }));
  void first.catch(() => {});
  try {
    await started.promise;
    const waiter = provider();
    const waiting = expect(ingest(waiter, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await waiting;
    expect(waiter.calls).toBe(0);
  } finally { release.resolve(); }
  await first;
  expect((await ingest()).skipped).toBe(true);
});

it("uses the casefolded session lock across actual processes on every filesystem", async () => {
  const workers = launchWorkers("case");
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.child.send("go"));
    const results = await Promise.all(workers.map(w => w.done));
    for (const result of results) expect(result.calls + result.skipped).toBe(1);
    const calls = results.reduce((sum, result) => sum + result.calls, 0);
    // Case-sensitive filesystems keep two distinct captures; case-insensitive filesystems
    // alias them and skip one. Both providers, when entered, assert ownership of the SAME lock.
    expect([1, 2]).toContain(calls);
    expect(await readdir(join(store.root, "sources"))).toHaveLength(calls);
    expect(factLines((await store.read(path))!.body)).toHaveLength(calls);
  } finally {
    for (const w of workers) if (w.child.exitCode === null) w.child.kill();
    await Promise.all(workers.map(w => w.exited));
  }
}, 30_000);

it.each(["ok", "S_1-a", "a".repeat(128), "a".repeat(129), "a/b", "", "é", "a.b"])
("pins the duplicated session-id filename contract to core: %j", async id => {
  const p = provider();
  if (isValidSessionId(id)) { await ingest(p, { sessionId: id }); expect(p.calls).toBeGreaterThan(0); }
  else { await expect(ingest(p, { sessionId: id })).rejects.toThrow("invalid ingest session id"); expect(p.calls).toBe(0); }
});

it("reports skipped unversioned pin checks and avoids rewriting unchanged statuses", async () => {
  await store.write(path, page("original evidence")); await addPin(store.root, pin());
  const check = (await recheckPins(store, [pin()]))[0]!;
  const { pageVersion: _version, ...unversioned } = check;
  expect(await applyPinChecks(store.root, [unversioned])).toEqual({ applied: 0, skipped: 1 });
  await utimes(join(store.root, "pins.json"), new Date(0), new Date(0));
  const opened = vi.spyOn(store, "read");
  await recheckStoredPins(store);
  expect(opened).toHaveBeenCalled();
  const before = await readFile(join(store.root, "pins.json"), "utf8");
  expect(await applyPinChecks(store.root, [check])).toEqual({ applied: 1, skipped: 0 });
  opened.mockClear();
  expect(await applyPinChecks(store, [check, check])).toEqual({ applied: 2, skipped: 0 });
  expect(opened).toHaveBeenCalledWith(path);
  expect(await readFile(join(store.root, "pins.json"), "utf8")).toBe(before);
  expect((await stat(join(store.root, "pins.json"))).mtimeMs).toBe(0);
});

it("keeps the empty-pin snapshot read-only even behind a stale mutation lock", async () => {
  await writePins(store.root, []);
  await utimes(join(store.root, "pins.json"), new Date(0), new Date(0));
  const lockPath = `${await realpath(store.root)}.write.lock`;
  await writeFile(lockPath, "fixture owner");
  expect(await recheckStoredPins(store, undefined, { timeoutMs: 0 })).toEqual([]);
  expect(await readFile(lockPath, "utf8")).toBe("fixture owner");
  expect((await stat(join(store.root, "pins.json"))).mtimeMs).toBe(0);
});

it("counts duplicate status-changing checks against the same inspected pin snapshot", async () => {
  await store.write(path, page("unrelated text")); await addPin(store.root, pin());
  const check = (await recheckPins(store, [pin()]))[0]!;
  expect(check.status).toBe("conflict");
  expect(await applyPinChecks(store, [check, check])).toEqual({ applied: 2, skipped: 0 });
  expect((await readPins(store.root))[0]!.status).toBe("conflict");
});

it("corrects legacy comment-only pin satisfaction without changing the page", async () => {
  await store.write(path, page("unrelated text\n<!-- distilled -->"));
  await addPin(store.root, pin("distilled"));
  const version = (await store.read(path))!.version;
  await recheckStoredPins(store);
  expect((await readPins(store.root))[0]!.status).toBe("conflict");
  expect((await store.read(path))!.version).toBe(version);
});

it("returns and renders skipped dream pin persistence even without an error callback", async () => {
  await store.write(path, page("- [stated] original evidence (doc:fixture)")); await addPin(store.root, pin());
  await store.upsertIndex({ path, slug: "shared", type: "concept", status: "active", summary: "original evidence" });
  const outputRoot = join(root, "dream-output");
  let phase = ""; let pruneReads = 0; let injected = false;
  const read = FileMemoryStore.prototype.read;
  vi.spyOn(FileMemoryStore.prototype, "read").mockImplementation(async function(target) {
    const current = await read.call(this, target);
    // The prune pass reads pages for the final index, then snapshots the pinned page. Change
    // the pin after that second read but before applyPinChecks's guarded validation.
    if (this.root === outputRoot && phase === "prune" && target === path && ++pruneReads === 2) {
      await addPin(outputRoot, { ...pin(), anchor: "new human anchor" }); injected = true;
    }
    return current;
  });
  const dream = await runDream({ wiki: store, raw: new FileRawStore({ root }), outputRoot,
    structuralOnly: true, onPhase: value => { phase = value; } });
  try {
    expect(injected).toBe(true);
    expect(dream.report.pinPersistence).toEqual({ applied: 0, skipped: 1 });
    expect(renderReport(dream.report)).toContain("pin status check(s) were not persisted");
    expect(dream.report.pinsAffected).toMatchObject([{ status: "kept" }]);
    expect(findingCount(dream.report)).toBe(1);
    // A conflict and failure to persist its status are two findings, not two distinct pins.
    expect(findingCount({ ...dream.report, pinsAffected: [{ ...dream.report.pinsAffected[0]!, status: "conflict" }] })).toBe(2);
    expect((await readPins(outputRoot))[0]!.anchor).toBe("new human anchor");
    expect((await readPins(store.root))[0]!.anchor).toBe("");
  } finally { await dream.workspace.dispose(); }
});

it("excludes capture comments from pin claim and anchor matching", async () => {
  await addPin(store.root, { ...pin("distilled"), page: sourcePath });
  await ingest();
  expect((await recheckStoredPins(store))[0]!.status).toBe("conflict");
  await addPin(store.root, { ...pin(), page: sourcePath, anchor: "ingest:coverage" });
  expect((await recheckStoredPins(store)).find(c => c.pin.anchor !== "")!.status).toBe("orphaned");
});

it("persists dream pin rechecks in the output only, and fails visibly on malformed pinned pages", async () => {
  await store.write(path, page("different fact")); await addPin(store.root, pin());
  const raw = new FileRawStore({ root });
  const dream = await runDream({ wiki: store, raw, structuralOnly: true });
  try {
    expect((await readPins(dream.outputRoot))[0]!.status).toBe("conflict");
    expect((await readPins(store.root))[0]!.status).toBe("active");
  } finally { await dream.workspace.dispose(); }
  await writeFile(join(store.root, path), "malformed");
  await expect(runDream({ wiki: store, raw, structuralOnly: true })).rejects.toThrow("missing frontmatter");
  expect(await readFile(join(store.root, path), "utf8")).toBe("malformed");
});
