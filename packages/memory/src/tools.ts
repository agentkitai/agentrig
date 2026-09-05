import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AnyTool, ToolContext } from "@agentkitai/agentrig-core";
import { pagePath, serializePage } from "./page.js";
import { unionRetrieve, withBackendRecall } from "./search.js";
import type { MemoryBackend } from "./backend.js";
import { applyPinChecks, readPins, recheckPins } from "./pins.js";
import type { FileMemoryStore } from "./store.js";
import type { FileRawStore } from "./raw.js";
import type { Attempt, WikiPage } from "./types.js";

/**
 * The memory tools the agent sees (PLAN §3.4). They are ordinary `Tool`s registered like any
 * other, so the loop, permissions, and event log treat memory exactly as it treats bash.
 *
 * `raw/` is never writable by the agent: `attempt_log` appends a new immutable file, and
 * `memory_ingest` copies a doc in. Nothing here rewrites a raw source.
 */

export interface MemoryToolsOptions {
  store: FileMemoryStore;
  raw?: FileRawStore;
  sessionId?: string;
  now?: () => number;
  /** Optional backend whose recall is unioned in (PLAN §3.8). Wrap with `tolerant()`. */
  backend?: MemoryBackend;
}

const SearchInput = z.object({
  query: z.string().min(1).describe("What you want to know"),
  k: z.number().int().positive().max(25).optional().describe("Max results (default 8)"),
});

const ReadInput = z.object({
  path: z.string().min(1).describe("Wiki-relative page path, e.g. concepts/retry-policy.md"),
});

const WriteInput = z.object({
  if_version: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional().describe("Version returned by memory_read or the last write receipt; absent/null creates only. On conflict merge current content and retry with its version."),
  type: z.enum(["entity", "concept", "source", "analysis"]),
  slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case"),
  body: z.string().min(1).describe("Fact lines: - [stated|observed|inferred] ... (source:ref)"),
  aliases: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const AnalysisInput = z.object({
  if_version: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional().describe("Version from memory_read or the last write receipt; absent/null creates only. Merge the returned current page on conflict."),
  slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case"),
  body: z.string().min(1).describe("The filed answer, as fact lines"),
});

const AttemptInput = z.object({
  hypothesis: z.string().min(1).describe("What you were trying"),
  actions: z.string().min(1).describe("1-3 line summary of what you did"),
  outcome: z.enum(["success", "failed", "abandoned", "reverted"]),
  evidence: z.array(z.string()).optional().describe("Error snippets, test output, event refs"),
  lesson: z.string().optional(),
});

const IngestInput = z.object({
  path: z.string().min(1).describe("Path to a doc to copy into raw/docs and remember"),
});

/** Re-check pins attached to one page after it was rewritten. */
async function pinConflictsFor(
  store: FileMemoryStore,
  path: string,
): Promise<Array<{ claim: string; reason: string }>> {
  const pins = (await readPins(store.root).catch(() => [])).filter((p) => p.page === path);
  if (pins.length === 0) return [];
  const checks = await recheckPins(store, pins);
  await applyPinChecks(store.root, checks);
  return checks.filter((c) => c.status !== "kept").map((c) => ({ claim: c.pin.claim, reason: c.reason }));
}

export function memoryTools(opts: MemoryToolsOptions): AnyTool[] {
  const { store } = opts;
  const now = opts.now ?? (() => Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const warningsText = (warnings: string[]) => warnings.map(warning => `\nWARNING: ${warning}`).join("");
  const conflict = (path: string, current: WikiPage | null, warnings: string[]) => ({
    output: { conflict: true, path, current, version: current?.version ?? null, warnings },
    display: `STALE WRITE: ${path}. Merge the current content, then retry with if_version=${JSON.stringify(current?.version ?? null)}.\n` +
      (current === null ? "The page is currently absent." : serializePage(current.frontmatter, current.body)) + warningsText(warnings),
    isError: true,
  });

  const search: AnyTool = {
    name: "memory_search",
    // Local retrieval is read-only. A backend may use the network outside the process sandbox.
    ...(opts.backend === undefined ? { sandbox: "compatible" as const } : {}),
    description:
      "Search project memory. Returns the union of index-selected pages and BM25 matches over " +
      "page bodies and durable aliases, with the path and a snippet for each. An index hint is not " +
      "the page: open it with memory_read before claiming information is absent.",
    inputSchema: SearchInput,
    permission: "read",
    execute: async (input: z.infer<typeof SearchInput>) => {
      const k = input.k ?? 8;
      const local = unionRetrieve(await store.index(), await store.pages(), input.query, k);
      // backend recall is unioned in after the local result, never in place of it
      const backendHits = opts.backend === undefined ? [] : await opts.backend.recall(input.query, k);
      const hits = withBackendRecall(local, backendHits, opts.backend?.id ?? "backend", k);
      if (hits.length === 0) {
        return { output: [], display: `no memory matches for ${JSON.stringify(input.query)}` };
      }
      return {
        output: hits.map((h) =>
          h.via === "backend"
            ? { ref: h.ref, via: h.via, snippet: h.text, ...(h.page === undefined ? {} : { page: h.page }) }
            : { path: h.page.path, via: h.via, snippet: h.snippet },
        ),
        display: hits
          .map((h) => (h.via === "backend" ? `${h.ref} [backend]\n  ${h.text}` : `${h.page.path} [${h.via}]\n  ${h.snippet}`))
          .join("\n"),
      };
    },
  };

  const read: AnyTool = {
    name: "memory_read",
    sandbox: "compatible",
    description: "Read one wiki page in full with its version token. Use that token as if_version when replacing it; index hints alone cannot establish absence.",
    inputSchema: ReadInput,
    permission: "read",
    execute: async (input: z.infer<typeof ReadInput>) => {
      let page: WikiPage | null;
      try { page = await store.read(input.path); }
      catch (err) { return { output: null, display: `cannot read ${input.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true }; }
      if (page === null) return { output: null, display: `no such page: ${input.path}`, isError: true };
      return { output: page, display: `version: ${page.version}\n${serializePage(page.frontmatter, page.body)}` };
    },
  };

  const write: AnyTool = {
    name: "memory_write",
    description:
      "Create or replace a wiki page. Replacement requires if_version from memory_read; omitted/null " +
      "means create-only. On conflict merge returned current content and retry with its version. " +
      "Aliases are durable names, not temporary task labels. Body must be fact lines, each tagged and carrying a source " +
      "ref. Record shape (contracts, decisions, reasons), never volatile values like a SHA or a " +
      "current version. raw/ is not writable.",
    inputSchema: WriteInput,
    permission: "write",
    execute: async (input: z.infer<typeof WriteInput>, ctx: ToolContext) => {
      const path = pagePath(input.type, input.slug);
      const result = await store.compareAndSwap(path, existing => ({
        path,
        frontmatter: {
          type: input.type,
          slug: input.slug,
          aliases: input.aliases ?? existing?.frontmatter.aliases ?? [],
          sources: input.sources ?? existing?.frontmatter.sources ?? [],
          updated: today(),
          confidence: input.confidence ?? existing?.frontmatter.confidence ?? "medium",
        },
        body: input.body,
      }), input.if_version ?? null, { signal: ctx.signal, index: {
        slug: input.slug,
        path,
        type: input.type,
        status: "active",
        summary: input.body.split("\n")[0]?.replace(/^- \[\w+\]\s*/, "").slice(0, 120) ?? "",
      } });
      if (!result.ok) return conflict(path, result.current, result.warnings);
      // a full-body replace is a regeneration: re-check any pin on this page so a human
      // correction can't be reverted silently (PLAN §3.6)
      let conflicts: Array<{ claim: string; reason: string }> = [];
      try { conflicts = await pinConflictsFor(store, path); }
      catch (error) { result.warnings.push(`page committed at ${path}; pin recheck failed: ${String(error)}`); }
      if (conflicts.length > 0) {
        return {
          output: { path, committed: true, version: result.version, pinConflicts: conflicts, warnings: result.warnings },
          display:
            `wrote ${path}\nWARNING: ${conflicts.length} pinned human correction(s) no longer hold:\n` +
            conflicts.map((c) => `  - ${c.claim} (${c.reason})`).join("\n") + warningsText(result.warnings),
          isError: true,
        };
      }
      return { output: { path, committed: true, version: result.version, warnings: result.warnings }, display: `wrote ${path}\nversion: ${result.version}` + warningsText(result.warnings) };
    },
  };

  const fileAnalysis: AnyTool = {
    name: "memory_file_analysis",
    description:
      "File an answer worth keeping (a comparison, an investigation, a root cause) into " +
      "analyses/, so explorations compound the way sources do. To replace an existing answer, read it " +
      "and provide if_version, or reuse the last write receipt's version when refining that same content. " +
      "A stale response includes current content to merge; omitted/null is create-only.",
    inputSchema: AnalysisInput,
    permission: "write",
    execute: async (input: z.infer<typeof AnalysisInput>, ctx: ToolContext) => {
      const path = pagePath("analysis", input.slug);
      const result = await store.compareAndSwap(path, existing => ({
        path,
        frontmatter: {
          type: "analysis",
          slug: input.slug,
          aliases: existing?.frontmatter.aliases ?? [],
          sources: [...new Set([...(existing?.frontmatter.sources ?? []), ...(opts.sessionId === undefined ? [] : [`session:${opts.sessionId}`])])],
          updated: today(),
          confidence: "medium",
        },
        body: input.body,
      }), input.if_version ?? null, { signal: ctx.signal, index: {
        slug: input.slug,
        path,
        type: "analysis",
        status: "active",
        summary: input.body.split("\n")[0]?.replace(/^- \[\w+\]\s*/, "").slice(0, 120) ?? "",
      } });
      if (!result.ok) return conflict(path, result.current, result.warnings);
      return { output: { path, committed: true, version: result.version, warnings: result.warnings }, display: `filed ${path}\nversion: ${result.version}` + warningsText(result.warnings) };
    },
  };

  const tools: AnyTool[] = [search, read, write, fileAnalysis];

  if (opts.raw !== undefined) {
    const raw = opts.raw;
    tools.push({
      name: "attempt_log",
      description:
        "Record a direction you tried while it is fresh — including failures. This ledger is " +
        "what lets the memory (and the supervisor) learn from what did not work.",
      inputSchema: AttemptInput,
      permission: "write",
      execute: async (input: z.infer<typeof AttemptInput>) => {
        const attempt: Attempt = {
          id: randomUUID().slice(0, 8),
          sessionId: opts.sessionId ?? "unknown",
          ts: now(),
          hypothesis: input.hypothesis,
          actions: input.actions,
          outcome: input.outcome,
          evidence: input.evidence ?? [],
          ...(input.lesson === undefined ? {} : { lesson: input.lesson }),
        };
        await raw.addAttempt(attempt);
        return { output: { id: attempt.id }, display: `logged attempt ${attempt.id} (${attempt.outcome})` };
      },
    });
    tools.push({
      name: "memory_ingest",
      description: "Copy a doc into raw/docs so it becomes a permanent source for memory.",
      inputSchema: IngestInput,
      permission: "write",
      paths: (input: z.infer<typeof IngestInput>) => [input.path],
      execute: async (input: z.infer<typeof IngestInput>) => {
        const doc = await raw.addDoc(input.path);
        return { output: doc, display: `ingested doc ${doc.id} -> ${doc.path}` };
      },
    });
  }

  return tools;
}

/**
 * `index.md` rendered for the system prompt (PLAN §3.2, index-first retrieval). Bounded: past
 * the cap the tail is replaced by a pointer to memory_search, so a large wiki degrades to
 * "search it" rather than eating the context window.
 */
export async function indexInjection(store: FileMemoryStore, maxChars = 4000): Promise<string> {
  const entries = (await store.index()).filter((e) => e.status === "active");
  if (entries.length === 0) return "";
  const header = "## Project memory (index)\n\nPages you can open with memory_read, or search with memory_search:";
  const lines: string[] = [];
  // the cap bounds the whole injection, header and tail included
  const tailReserve = 60;
  let size = header.length + tailReserve;
  let omitted = 0;
  for (const e of entries) {
    const line = `- ${e.path} — ${e.summary}`;
    if (size + line.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    size += line.length + 1;
  }
  const tail = omitted === 0 ? "" : `\n- …and ${omitted} more pages; use memory_search to find them.`;
  return `${header}\n${lines.join("\n")}${tail}`;
}
