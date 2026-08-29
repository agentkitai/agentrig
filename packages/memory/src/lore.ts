import { serializePage } from "./page.js";
import type { BackendHit, Conflict, MemoryBackend, SourceRef } from "./backend.js";
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
    const env = loreConfigFromEnv();
    this.apiUrl = (opts.apiUrl ?? env?.apiUrl ?? "").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? env?.apiKey ?? "";
    this.project = opts.project ?? env?.project ?? "default";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (this.apiUrl === "") throw new Error("lore: LORE_API_URL is not set");
  }

  private async request(path: string, body: JsonObject): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`lore: HTTP ${res.status} ${detail.slice(0, 300)}`);
      }
      return (await res.json().catch(() => ({}))) as JsonObject;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Push distilled facts as Lore memories, tagged so they can be traced back to the wiki. */
  async onIngest(facts: DistilledFact[], source: SourceRef): Promise<void> {
    if (facts.length === 0) return;
    await this.request("/v1/memories", {
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
    });
  }

  /** Extra recall, unioned with index ∪ BM25 by the caller — never a replacement. */
  async recall(query: string, k: number): Promise<BackendHit[]> {
    const data = await this.request("/v1/retrieve", { project: this.project, query, limit: k });
    const rows = Array.isArray(data.memories) ? data.memories : Array.isArray(data.results) ? data.results : [];
    return (rows as JsonObject[])
      .map((row): BackendHit | null => {
        const text = typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : null;
        if (text === null) return null;
        const id = String(row.id ?? row.memory_id ?? "");
        const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
        const pageTag = tags.find((t) => t.startsWith("page:"));
        const hit: BackendHit = { id, text, score: typeof row.score === "number" ? row.score : 0 };
        if (pageTag !== undefined) hit.page = pageTag.slice("page:".length);
        return hit;
      })
      .filter((h): h is BackendHit => h !== null);
  }

  /** Promotion to global scope: private → shared, the wiki page carried across as one memory. */
  async promote(page: WikiPage): Promise<void> {
    await this.request("/v1/memories/promote", {
      project: this.project,
      scope: "shared",
      memory: {
        content: serializePage(page.frontmatter, page.body),
        tags: ["agentrig", `project:${this.project}`, `page:${page.frontmatter.type}/${page.frontmatter.slug}`],
        metadata: { agentrig: `${this.project}/${page.path}` },
      },
    });
  }

  /** Contradiction check consulted by the dream (M5); the wiki lint still runs regardless. */
  async conflicts(facts: DistilledFact[]): Promise<Conflict[]> {
    if (facts.length === 0) return [];
    const data = await this.request("/v1/conflicts", {
      project: this.project,
      facts: facts.map((f) => ({ content: f.text, tags: [`page:${f.pageType}/${f.slug}`] })),
    });
    const rows = Array.isArray(data.conflicts) ? (data.conflicts as JsonObject[]) : [];
    return rows
      .map((row): Conflict | null => {
        const fact = typeof row.fact === "string" ? row.fact : null;
        const existing = typeof row.existing === "string" ? row.existing : null;
        if (fact === null || existing === null) return null;
        const conflict: Conflict = { fact, existing, existingId: String(row.existing_id ?? row.id ?? "") };
        if (typeof row.detail === "string") conflict.detail = row.detail;
        return conflict;
      })
      .filter((c): c is Conflict => c !== null);
  }
}
