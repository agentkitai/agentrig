import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider } from "@agentkitai/agentrig-core";
import {
  FileMemoryStore,
  LoreBackend,
  ingestSession,
  loreConfigFromEnv,
  memoryTools,
  tagsFor,
  tolerant,
  unionRetrieve,
  withBackendRecall,
} from "@agentkitai/agentrig-memory";
import type { BackendHit, MemoryBackend, UnionHit, WikiPage } from "@agentkitai/agentrig-memory";

const at = () => Date.parse("2026-08-29T00:00:00Z");
let root: string;
let store: FileMemoryStore;

const reply = (obj: unknown): ModelProvider => ({
  id: "fake",
  model: "f",
  capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: JSON.stringify(obj) };
    yield { type: "stop", reason: "end_turn" };
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-backend-"));
  store = new FileMemoryStore({ root: join(root, "wiki"), now: at });
  await store.init();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loreConfigFromEnv — the default is no infrastructure", () => {
  it("is null unless both URL and key are set", () => {
    expect(loreConfigFromEnv({})).toBeNull();
    expect(loreConfigFromEnv({ LORE_API_URL: "https://lore.example" })).toBeNull();
    expect(loreConfigFromEnv({ LORE_API_URL: "", LORE_API_KEY: "k" })).toBeNull();
    expect(loreConfigFromEnv({ LORE_API_URL: "https://lore.example", LORE_API_KEY: "k" })).toEqual({
      apiUrl: "https://lore.example",
      apiKey: "k",
      project: "default",
    });
    expect(loreConfigFromEnv({ LORE_API_URL: "u", LORE_API_KEY: "k", LORE_PROJECT: "agentrig" })?.project).toBe("agentrig");
  });
});

describe("LoreBackend REST mapping — no network", () => {
  const capture = () => {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string }> = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init!.body)) as Record<string, unknown>,
        auth: (init!.headers as Record<string, string>).authorization ?? "",
      });
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    };
    return { calls, fetchFn };
  };

  it("posts ingested facts tagged for traceability, with provenance both ways", async () => {
    const { calls, fetchFn } = capture();
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", project: "agentrig", fetchFn });
    await backend.onIngest(
      [{ pageType: "concept", slug: "retry-policy", tag: "stated", text: "Retries are per request" }],
      { ref: "session:s1", project: "agentrig" },
    );
    expect(calls[0]!.path).toBe("/v1/memories");
    expect(calls[0]!.auth).toBe("Bearer k");
    const memories = calls[0]!.body.memories as Array<Record<string, unknown>>;
    expect(memories[0]!.tags).toEqual(["agentrig", "project:agentrig", "session:s1", "page:concept/retry-policy"]);
    // the Lore memory records which wiki page it came from
    expect(memories[0]!.metadata).toMatchObject({ agentrig: "agentrig/concept/retry-policy", source: "session:s1" });
  });

  it("does not call the server for an empty fact list", async () => {
    const { calls, fetchFn } = capture();
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", fetchFn });
    await backend.onIngest([], { ref: "session:s1", project: "p" });
    expect(calls).toEqual([]);
  });

  it("maps recall rows, tolerating either response shape", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          memories: [
            { id: "m1", content: "Retries are per request", score: 0.9, tags: ["page:concept/retry-policy"] },
            { memory_id: "m2", text: "Something else", score: 0.4, tags: [] },
            { id: "m3" }, // no content: must be dropped rather than surfacing an empty hit
          ],
        }),
        { status: 200 },
      );
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", fetchFn });
    const hits = await backend.recall("retries", 5);
    expect(hits).toEqual([
      { id: "m1", text: "Retries are per request", score: 0.9, page: "concept/retry-policy" },
      { id: "m2", text: "Something else", score: 0.4 },
    ]);
  });

  it("promotes a page as one shared memory", async () => {
    const { calls, fetchFn } = capture();
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", project: "agentrig", fetchFn });
    const page: WikiPage = {
      path: "concepts/retry-policy.md",
      frontmatter: { type: "concept", slug: "retry-policy", aliases: [], sources: [], updated: "2026-08-29", confidence: "high" },
      body: "- [stated] Retries are per request",
      updatedAt: 0,
    };
    await backend.promote(page);
    expect(calls[0]!.path).toBe("/v1/memories/promote");
    expect(calls[0]!.body.scope).toBe("shared");
    expect(String((calls[0]!.body.memory as Record<string, unknown>).content)).toContain("slug: retry-policy");
  });

  it("maps conflicts for the dream's contradiction pass", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({ conflicts: [{ fact: "per request", existing: "per batch", existing_id: "m9", detail: "superseded" }] }),
        { status: 200 },
      );
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", fetchFn });
    expect(await backend.conflicts([{ pageType: "concept", slug: "x", tag: "stated", text: "per request" }])).toEqual([
      { fact: "per request", existing: "per batch", existingId: "m9", detail: "superseded" },
    ]);
  });

  it("surfaces an HTTP failure (the caller decides to swallow it)", async () => {
    const fetchFn: typeof fetch = async () => new Response("nope", { status: 500 });
    const backend = new LoreBackend({ apiUrl: "https://lore.example", apiKey: "k", fetchFn });
    await expect(backend.recall("x", 3)).rejects.toThrow(/HTTP 500/);
  });

  it("refuses to construct without a URL rather than silently doing nothing", () => {
    expect(() => new LoreBackend({ apiUrl: "", apiKey: "k" })).toThrow(/LORE_API_URL/);
  });

  it("tags a source-level ref when the fact has no page", () => {
    expect(tagsFor({ ref: "doc:adr-012", project: "p", page: "concept/x" })).toEqual([
      "agentrig",
      "project:p",
      "doc:adr-012",
      "page:concept/x",
    ]);
  });
});

describe("tolerant() — a backend can never block or break the wiki", () => {
  const exploding: MemoryBackend = {
    id: "boom",
    onIngest: async () => {
      throw new Error("backend down");
    },
    recall: async () => {
      throw new Error("backend down");
    },
    promote: async () => {
      throw new Error("backend down");
    },
    conflicts: async () => {
      throw new Error("backend down");
    },
  };

  it("turns every failure into a reported no-op", async () => {
    const errors: string[] = [];
    const safe = tolerant(exploding, (op, err) => errors.push(`${op}: ${err.message}`));
    await expect(safe.onIngest([], { ref: "r", project: "p" })).resolves.toBeUndefined();
    await expect(safe.recall("q", 3)).resolves.toEqual([]);
    await expect(safe.promote({} as WikiPage)).resolves.toBeUndefined();
    await expect(safe.conflicts!([])).resolves.toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("backend down");
  });

  it("omits conflicts when the wrapped backend has none", () => {
    const minimal: MemoryBackend = { id: "m", onIngest: async () => {}, recall: async () => [], promote: async () => {} };
    expect(tolerant(minimal, () => {}).conflicts).toBeUndefined();
  });

  it("an exploding backend does not stop a session being ingested into the wiki", async () => {
    await mkdir(join(root, "raw", "sessions"), { recursive: true });
    const logPath = join(root, "raw", "sessions", "s1.jsonl");
    await writeFile(logPath, JSON.stringify({ type: "session.start", task: "t", cwd: "/w" }) + "\n");
    const result = await ingestSession({
      store,
      provider: reply({
        nothingDurable: false,
        summary: "did a thing",
        facts: [{ pageType: "concept", slug: "retry-policy", tag: "stated", text: "per request" }],
      }),
      sessionId: "s1",
      logPath,
      now: at,
      backend: tolerant(exploding, () => {}),
    });
    expect(result.factCount).toBe(1);
    expect((await store.read("concepts/retry-policy.md"))!.body).toContain("per request");
  });
});

describe("withBackendRecall — union only, never a replacement", () => {
  const page = (slug: string, body: string): WikiPage => ({
    path: `concepts/${slug}.md`,
    frontmatter: { type: "concept", slug, aliases: [], sources: [], updated: "2026-08-29", confidence: "high" },
    body,
    updatedAt: 0,
  });
  const local: UnionHit[] = [
    { page: page("retry-policy", "- [stated] retries"), score: 2, snippet: "- [stated] retries", via: "both" },
  ];
  const hits = (xs: Array<Partial<BackendHit>>): BackendHit[] =>
    xs.map((x, i) => ({ id: x.id ?? `m${i}`, text: x.text ?? "t", score: x.score ?? 0, ...(x.page === undefined ? {} : { page: x.page }) }));

  it("keeps every local hit and appends backend hits after them", () => {
    const out = withBackendRecall(local, hits([{ id: "m1", text: "from lore", score: 0.9 }]), "lore");
    expect(out).toHaveLength(2);
    expect(out[0]!.via).toBe("both");
    expect(out[1]).toMatchObject({ via: "backend", ref: "lore:m1", text: "from lore" });
  });

  it("drops a backend hit that duplicates a page already returned locally", () => {
    const out = withBackendRecall(local, hits([{ page: "concept/retry-policy", text: "dup" }]), "lore");
    expect(out).toHaveLength(1);
  });

  it("is a no-op with no backend, so recall can never regress", () => {
    expect(withBackendRecall(local, [], "lore")).toEqual(local);
  });

  it("orders backend-only hits by score", () => {
    const out = withBackendRecall([], hits([{ id: "a", score: 0.2 }, { id: "b", score: 0.8 }]), "lore");
    expect(out.map((h) => (h.via === "backend" ? h.ref : ""))).toEqual(["lore:b", "lore:a"]);
  });
});

describe("memory_search with a backend", () => {
  it("unions backend recall into the tool result", async () => {
    await store.write("concepts/retry-policy.md", {
      path: "concepts/retry-policy.md",
      frontmatter: { type: "concept", slug: "retry-policy", aliases: [], sources: [], updated: "2026-08-29", confidence: "high" },
      body: "- [stated] retries are per request",
    });
    const backend: MemoryBackend = {
      id: "lore",
      onIngest: async () => {},
      recall: async () => [{ id: "m1", text: "a memory only lore has", score: 0.9 }],
      promote: async () => {},
    };
    const search = memoryTools({ store, backend }).find((t) => t.name === "memory_search")!;
    const r = await search.execute({ query: "retries" }, {
      cwd: root,
      sessionId: "s",
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(r.display).toContain("concepts/retry-policy.md");
    expect(r.display).toContain("lore:m1 [backend]");
  });
});
