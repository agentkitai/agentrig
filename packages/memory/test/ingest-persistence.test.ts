import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, addPin, applyPinChecks, ingestSession, memoryTools, readPins, recheckPins,
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

it("preserves multiline fact text and regex punctuation across provenance and re-ingest", async () => {
  const text = "literal [x] + $value\nsecond line (details)";
  const backend: MemoryBackend = { id: "fixture", recall: async () => [], promote: async () => {},
    onIngest: async () => [{ factText: text, memoryId: "m$1" }] };
  await ingest(provider(text), { backend });
  expect((await store.read(path))!.body).toContain(`${text} (session:s1, fixture:m$1)`);
  await log([...events, { type: "session.end", reason: "done" }]);
  await ingest(provider(text), { backend });
  expect((await store.read(path))!.body.split(text)).toHaveLength(2);
  expect((await store.read(sourcePath))!.body.split(text)).toHaveLength(2);
});

it("preserves concurrent pin additions and refuses stale pin/page checks", async () => {
  await store.write(path, page("other content"));
  await Promise.all(Array.from({ length: 12 }, (_, i) => addPin(store.root, pin(`claim ${i}`))));
  expect(await readPins(store.root)).toHaveLength(12);
  const old = (await readPins(store.root))[0]!;
  const checks = await recheckPins(store, [old]);
  await addPin(store.root, { ...old, anchor: "new human anchor" });
  await applyPinChecks(store.root, checks);
  expect((await readPins(store.root)).find(p => p.claim === old.claim)).toMatchObject({ anchor: "new human anchor", status: "active" });
  const fresh = await readPins(store.root);
  const snapshot = await recheckPins(store, fresh);
  await store.write(path, page(fresh.map(p => p.claim).join("\n")));
  await applyPinChecks(store.root, snapshot);
  expect((await readPins(store.root)).every(p => p.status === "active")).toBe(true);
  await writePins(store.root, []);
  await applyPinChecks(store.root, await recheckPins(store, [old]));
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

it("conserves shared facts, sources and pins across actual ingest processes", async () => {
  const workers = ["first", "second"].map(name => {
    const child = fork(new URL("./fixtures/ingest-writer.mjs", import.meta.url), [store.root, logPath, name],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = ""; child.stderr!.on("data", data => { errors += data; });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
      child.once("exit", code => reject(new Error(`worker ${name}: ${code}: ${errors}`)));
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on("message", message => {
        const msg = message as { done?: boolean; error?: string };
        if (msg.done) resolve(); if (msg.error) reject(new Error(msg.error));
      });
      child.once("error", reject); child.once("exit", code => reject(new Error(`worker ${name}: ${code}: ${errors}`)));
    });
    void done.catch(() => {});
    return { child, ready, done, exited };
  });
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
