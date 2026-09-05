import { z } from "zod";
import { serializePage } from "./page.js";
import type { BackendAck, BackendCallOptions, BackendHit, Conflict, MemoryBackend, SourceRef } from "./backend.js";
import type { DistilledFact } from "./ingest.js";
import type { WikiPage } from "./types.js";

/**
 * Lore adapter (PLAN §3.8) — AgentKit's cross-agent memory server as an optional sink and extra
 * recall source. Speaks Lore's REST API directly with an injectable `fetchFn`, so the whole
 * adapter is testable without a server.
 *
 * Everything here is additive: `recall` supplements index ∪ BM25, it never replaces it, and a
 * failure is the caller's to swallow (see `tolerant`). The wiki remains the source of truth.
 */

export interface LoreBackendOptions {
  apiUrl?: string;
  apiKey?: string;
  project?: string;
  fetchFn?: typeof fetch;
  /** Milliseconds before a request is abandoned; a slow backend must not stall the harness. */
  timeoutMs?: number;
}

export interface LoreConfig {
  apiUrl: string;
  apiKey: string;
  project: string;
}

/** Read Lore config from the environment; null when not configured (the no-infra default). */
export function loreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LoreConfig | null {
  const apiUrl = env.LORE_API_URL;
  const apiKey = env.LORE_API_KEY;
  if (apiUrl === undefined || apiUrl === "" || apiKey === undefined || apiKey === "") return null;
  return { apiUrl, apiKey, project: env.LORE_PROJECT ?? "default" };
}

type JsonObject = Record<string, unknown>;

/**
 * Response shapes are validated per row, not per envelope: a real server returning one null or
 * malformed row must not discard every valid row alongside it.
 */
const RecallRow = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  memory_id: z.union([z.string(), z.number()]).optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  score: z.coerce.number().optional(),
  tags: z.array(z.union([z.string(), z.number()])).optional(),
});

const ConflictRow = z.object({
  fact: z.string(),
  existing: z.string(),
  existing_id: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  detail: z.string().optional(),
});

const AckRow = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  memory_id: z.union([z.string(), z.number()]).optional(),
  content: z.string().optional(),
  text: z.string().optional(),
});

function rowsOf(data: unknown, ...keys: string[]): unknown[] {
  if (data === null || typeof data !== "object") return [];
  const obj = data as JsonObject;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

/** Tags every memory carries, so AgentRig-authored content is identifiable and scoped in Lore. */
export function tagsFor(source: SourceRef, fact?: DistilledFact): string[] {
  const tags = ["agentrig", `project:${source.project}`, source.ref];
  const page = fact === undefined ? source.page : `${fact.pageType}/${fact.slug}`;
  if (page !== undefined) tags.push(`page:${page}`);
  return tags;
}

export class LoreBackend implements MemoryBackend {
  readonly id = "lore";
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly project: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LoreBackendOptions = {}) {
    // only consult the environment for values the caller did not supply, so an explicitly
    // constructed backend is not perturbed by ambient LORE_* vars
    const env = opts.apiUrl === undefined || opts.apiKey === undefined || opts.project === undefined
      ? loreConfigFromEnv()
      : null;
    this.apiUrl = (opts.apiUrl ?? env?.apiUrl ?? "").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? env?.apiKey ?? "";
    this.project = opts.project ?? env?.project ?? "default";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (this.apiUrl === "") throw new Error("lore: LORE_API_URL is not set");
  }

  private async request(path: string, body: JsonObject, opts: BackendCallOptions = {}): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`lore request timed out after ${this.timeoutMs}ms`, "TimeoutError")), this.timeoutMs);
    const signal = opts.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, opts.signal]);
    try {
      signal.throwIfAborted();
      const res = await this.fetchFn(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        if (reader !== undefined) for (;;) {
          signal.throwIfAborted();
          const item = await reader.read();
          signal.throwIfAborted();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error(`lore: HTTP ${res.status}; response exceeds 2 MiB`);
          chunks.push(item.value);
        }
      } finally {
        try { void reader?.cancel().catch(() => {}); } catch { /* best-effort stream cleanup */ }
      }
      const text = Buffer.concat(chunks, bytes).toString("utf8");
      if (!res.ok) throw new Error(`lore: HTTP ${res.status} ${text.slice(0, 300)}`);
      try { return JSON.parse(text) as JsonObject; } catch { return {}; }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Push distilled facts as Lore memories, tagged so they can be traced back to the wiki. */
  async onIngest(facts: DistilledFact[], source: SourceRef, opts: BackendCallOptions = {}): Promise<BackendAck[]> {
    if (facts.length === 0) return [];
    const data = await this.request("/v1/memories", {
      project: this.project,
      memories: facts.map((f) => ({
        content: f.text,
        tags: tagsFor(source, f),
        metadata: {
          // provenance the other way: a Lore memory says which wiki page it came from
          agentrig: `${source.project}/${f.pageType}/${f.slug}`,
          source: source.ref,
          tag: f.tag,
        },
      })),
    }, opts);
    // ids come back so the wiki can record `lore:<memory-id>` on the fact lines it just wrote
    const acks: BackendAck[] = [];
    for (const raw of rowsOf(data, "memories", "results", "created")) {
      const row = AckRow.safeParse(raw);
      if (!row.success) continue;
      const memoryId = String(row.data.id ?? row.data.memory_id ?? "");
      const factText = row.data.content ?? row.data.text ?? "";
      if (memoryId !== "" && factText !== "") acks.push({ factText, memoryId });
    }
    return acks;
  }

  /** Extra recall, unioned with index ∪ BM25 by the caller — never a replacement. */
  async recall(query: string, k: number, opts: BackendCallOptions = {}): Promise<BackendHit[]> {
    const data = await this.request("/v1/retrieve", { project: this.project, query, limit: k }, opts);
    const hits: BackendHit[] = [];
    for (const raw of rowsOf(data, "memories", "results")) {
      const row = RecallRow.safeParse(raw);
      if (!row.success) continue; // one bad row must not discard the rest
      const text = row.data.content ?? row.data.text;
      if (text === undefined) continue;
      const tags = (row.data.tags ?? []).map(String);
      const pageTag = tags.find((t) => t.startsWith("page:"));
      const hit: BackendHit = {
        id: String(row.data.id ?? row.data.memory_id ?? ""),
        text,
        score: row.data.score ?? 0,
      };
      if (pageTag !== undefined) hit.page = pageTag.slice("page:".length);
      hits.push(hit);
    }
    // the server is asked for `limit`, but never trusted with the bound
    return hits.slice(0, k);
  }

  /** Promotion to global scope: private → shared, the wiki page carried across as one memory. */
  async promote(page: WikiPage, opts: BackendCallOptions = {}): Promise<void> {
    const pageRef = `${page.frontmatter.type}/${page.frontmatter.slug}`;
    await this.request("/v1/memories/promote", {
      project: this.project,
      scope: "shared",
      memory: {
        content: serializePage(page.frontmatter, page.body, {}, page.extraFrontmatter),
        tags: ["agentrig", `project:${this.project}`, `page:${pageRef}`],
        // same namespace onIngest uses, so a promoted page and its facts are traceable together
        metadata: { agentrig: `${this.project}/${pageRef}` },
      },
    }, opts);
  }

  /** Contradiction check consulted by the dream (M5); the wiki lint still runs regardless. */
  async conflicts(facts: DistilledFact[], opts: BackendCallOptions = {}): Promise<Conflict[]> {
    if (facts.length === 0) return [];
    const data = await this.request("/v1/conflicts", {
      project: this.project,
      facts: facts.map((f) => ({ content: f.text, tags: [`page:${f.pageType}/${f.slug}`] })),
    }, opts);
    const out: Conflict[] = [];
    for (const raw of rowsOf(data, "conflicts")) {
      const row = ConflictRow.safeParse(raw);
      if (!row.success) continue;
      const conflict: Conflict = {
        fact: row.data.fact,
        existing: row.data.existing,
        existingId: String(row.data.existing_id ?? row.data.id ?? ""),
      };
      if (row.data.detail !== undefined) conflict.detail = row.data.detail;
      out.push(conflict);
    }
    return out;
  }
}
