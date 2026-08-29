import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, eventsToTranscript, extractJson, ingestSession, planCoverage } from "@agentkitai/agentrig-memory";

/** Replies with a scripted JSON distillation per span. No network anywhere. */
function scriptedProvider(replies: string[]): ModelProvider & { calls: number } {
  let i = 0;
  const p = {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
    calls: 0,
    async *stream(): AsyncIterable<ModelEvent> {
      p.calls += 1;
      yield { type: "text_delta", text: replies[Math.min(i++, replies.length - 1)]! };
      yield { type: "usage", usage: { input: 1, output: 1 } };
      yield { type: "stop", reason: "end_turn" };
    },
  };
  return p;
}

let root: string;
let store: FileMemoryStore;
let logPath: string;
const at = () => Date.parse("2026-08-29T00:00:00Z");

const events = [
  { type: "session.start", task: "make retries per-request", cwd: "/w" },
  { type: "model.delta", text: "noise that must not reach the transcript" },
  { type: "tool.call", name: "bash", input: { command: "pnpm test" } },
  { type: "tool.result", ok: false, display: "FAIL retry.test.ts expected per request" },
  { type: "file.changed", op: "edit", path: "src/retry.ts" },
  { type: "session.end", reason: "done" },
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-ingest-"));
  store = new FileMemoryStore({ root: join(root, "wiki"), now: at });
  await store.init();
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
  logPath = join(root, "raw", "sessions", "s1.jsonl");
  await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("transcript and coverage planning", () => {
  it("drops model.delta noise but keeps tool calls, results, and file changes", () => {
    const t = eventsToTranscript(events);
    expect(t).not.toContain("noise that must not reach");
    expect(t).toContain("[tool.call] bash");
    expect(t).toContain("[tool.result] ok=false");
    expect(t).toContain("[file.changed] edit src/retry.ts");
  });

  it("splits into bounded spans that cover every line exactly once", () => {
    const transcript = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const spans = planCoverage(transcript, 500);
    expect(spans.length).toBeGreaterThan(1);
    // contiguous, no gaps, no overlaps
    expect(spans[0]!.from).toBe(0);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.from).toBe(spans[i - 1]!.to + 1);
    expect(spans.map((s) => s.text).join("\n").split("\n")).toHaveLength(50);
  });

  it("handles an empty transcript", () => {
    expect(planCoverage("")).toEqual([]);
  });
});

describe("extractJson", () => {
  it("unwraps fenced JSON and tolerates prose around it", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson("no json here")).toThrow(/no JSON object/);
  });
});

const distillation = JSON.stringify({
  nothingDurable: false,
  summary: "Made retries per-request after a failing test",
  facts: [
    { pageType: "concept", slug: "retry-policy", tag: "stated", text: "Retries apply per request, not per batch" },
    { pageType: "entity", slug: "retry-module", tag: "observed", text: "src/retry.ts owns the backoff loop" },
  ],
});

describe("ingestSession", () => {
  it("writes a source page, reserves and fills target pages, and updates index and log", async () => {
    const provider = scriptedProvider([distillation]);
    const result = await ingestSession({ store, provider, sessionId: "s1", logPath, now: at });

    expect(result.factCount).toBe(2);
    expect(result.coverage.every((c) => c.outcome === "distilled")).toBe(true);
    expect(result.pagesReserved).toEqual(
      expect.arrayContaining(["concepts/retry-policy.md", "entities/retry-module.md"]),
    );

    const source = await store.read("sources/session-s1.md");
    expect(source!.body).toContain("Made retries per-request");
    expect(source!.frontmatter.sources).toEqual(["session:s1"]);

    const concept = await store.read("concepts/retry-policy.md");
    expect(concept!.body).toContain("- [stated] Retries apply per request, not per batch (session:s1)");
    expect(concept!.body).not.toContain("Reserved by"); // placeholder text replaced
    expect(concept!.frontmatter.sources).toContain("session:s1");

    const index = await store.index();
    expect(index.map((e) => e.slug).sort()).toEqual(["retry-module", "retry-policy", "session-s1"]);
    expect(index.every((e) => e.status === "active")).toBe(true);

    expect(await readFile(join(root, "wiki", "log.md"), "utf8")).toContain("ingest | session:s1 | 2 facts");
  });

  it("records a nothing-durable span as covered rather than losing it", async () => {
    const provider = scriptedProvider([JSON.stringify({ nothingDurable: true, summary: "", facts: [] })]);
    const result = await ingestSession({ store, provider, sessionId: "s1", logPath, now: at });

    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0]!.outcome).toBe("nothing-durable");
    expect(result.factCount).toBe(0);
    // the source page still exists, so the session is provably accounted for
    expect((await store.read("sources/session-s1.md"))!.body).toContain("no durable findings");
  });

  it("covers every span of a long session", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      type: "tool.result",
      ok: true,
      display: `step ${i} ${"y".repeat(100)}`,
    }));
    await writeFile(logPath, many.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const provider = scriptedProvider([JSON.stringify({ nothingDurable: true, summary: "", facts: [] })]);
    const result = await ingestSession({ store, provider, sessionId: "s1", logPath, now: at });

    expect(result.coverage.length).toBeGreaterThan(1);
    expect(provider.calls).toBe(result.coverage.length); // one call per span, none skipped
  });

  it("fails loudly when a span cannot be distilled, rather than silently losing it", async () => {
    const provider = scriptedProvider(["I'm afraid I can't do that"]);
    await expect(ingestSession({ store, provider, sessionId: "s1", logPath, now: at })).rejects.toThrow(
      /could not be distilled/,
    );
  });

  it("skips a stale re-capture and supersedes a growing one", async () => {
    await ingestSession({ store, provider: scriptedProvider([distillation]), sessionId: "s1", logPath, now: at });

    // same log again -> stale, skip
    const again = await ingestSession({
      store,
      provider: scriptedProvider([distillation]),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(again.skipped).toBe(true);
    expect(again.factCount).toBe(0);

    // log grew (session_end fired twice on a growing transcript) -> supersede
    await writeFile(
      logPath,
      [...events, { type: "tool.result", ok: true, display: "all green now" }]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const grown = await ingestSession({
      store,
      provider: scriptedProvider([distillation]),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(grown.skipped).toBe(false);
    expect(grown.supersededPrevious).toBe(true);
  });

  it("does not duplicate a fact line already on the page", async () => {
    const opts = { store, sessionId: "s1", logPath, now: at };
    await ingestSession({ ...opts, provider: scriptedProvider([distillation]) });
    // force a re-ingest of identical content by growing the log trivially
    await writeFile(logPath, [...events, { type: "error", fatal: false, message: "z" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    await ingestSession({ ...opts, provider: scriptedProvider([distillation]) });

    const body = (await store.read("concepts/retry-policy.md"))!.body;
    const occurrences = body.split("Retries apply per request").length - 1;
    expect(occurrences).toBe(1);
  });

  it("passes the attempts ledger to the model", async () => {
    let seen = "";
    const provider: ModelProvider = {
      id: "fake",
      model: "f",
      capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(req): AsyncIterable<ModelEvent> {
        seen += JSON.stringify(req.messages);
        yield { type: "text_delta", text: distillation };
        yield { type: "stop", reason: "end_turn" };
      },
    };
    await ingestSession({
      store,
      provider,
      sessionId: "s1",
      logPath,
      now: at,
      attempts: [
        {
          id: "a1",
          sessionId: "s1",
          ts: 1,
          hypothesis: "retry is per batch",
          actions: "read the code",
          outcome: "failed",
          evidence: [],
          lesson: "it is per request",
        },
      ],
    });
    expect(seen).toContain("retry is per batch");
    expect(seen).toContain("it is per request");
  });
});
