/**
 * Shared types for the LLM Wiki memory (PLAN §3). Implementations live alongside;
 * the dream (M5) is still interface-only. Nothing here imports core internals beyond types.
 */
import type { AuxiliaryReport, ModelProvider } from "@agentkitai/agentrig-core";
import type { ClaimPromotionAssessment } from "./dream/promote.js";
import type { ScanOptions } from "./scan.js";

export type Scope = "project" | "global";
export type PageType = "entity" | "concept" | "source" | "analysis";
export type FactTag = "stated" | "observed" | "inferred";

export interface PageFrontmatter {
  type: PageType;
  slug: string;
  aliases: string[];
  sources: string[]; // "session:<id>" | "doc:<id>"
  updated: string;   // ISO date
  confidence: "high" | "medium" | "low";
}

export interface WikiPage {
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  updatedAt: number;
  /** Hash of persisted bytes, supplied by version-aware stores. Not a model assertion. */
  version?: string;
}

export interface IndexEntry {
  slug: string;
  path: string;
  type: PageType;
  summary: string;
  status: "planned" | "active";
  claimedBy?: string[];
}

export interface MemoryStore {
  root: string;
  scope: Scope;
  index(): Promise<IndexEntry[]>;
  read(path: string): Promise<WikiPage | null>;
  write(path: string, page: Omit<WikiPage, "updatedAt">): Promise<void>;
  /** Atomic placeholder reservation so concurrent ingests converge on one page. */
  reserve(slug: string, claimant: string): Promise<"created" | "exists">;
  appendLog(entry: string): Promise<void>;
  search(query: string, k?: number): Promise<Array<{ page: WikiPage; score: number; snippet: string }>>;
}

export interface SessionLogRef { id: string; path: string; updatedAt: number }
export interface DocRef { id: string; path: string; addedAt: number }

export interface RawStore {
  sessions(since?: number, opts?: ScanOptions): Promise<SessionLogRef[]>;
  docs(opts?: ScanOptions): Promise<DocRef[]>;
  addDoc(path: string): Promise<DocRef>;
}

export interface Attempt {
  id: string;
  sessionId: string;
  ts: number;
  hypothesis: string;
  actions: string;
  outcome: "success" | "failed" | "abandoned" | "reverted";
  evidence: string[];
  lesson?: string;
}

export interface Pin {
  page: string;
  kind: "correction" | "addition" | "deletion";
  claim: string;
  anchor: string; // section heading, not line numbers
  provenance: "human";
  created: string;
  status: "active" | "conflict" | "orphaned";
}

export interface DreamInput {
  wiki: MemoryStore;
  raw: RawStore;
  globalWiki?: MemoryStore;
  provider: ModelProvider;
}

export interface DreamReport {
  contradictions: Array<{ pages: string[]; claims: string[]; resolution: string }>;
  superseded: Array<{ page: string; old: string; new: string; source: string }>;
  orphans: string[];
  missingPages: Array<{ concept: string; mentionedIn: string[] }>;
  merged: Array<{ from: string[]; to: string }>;
  removed: Array<{ page: string; line: string; reason: string }>;
  promoted: Array<{ from: string; toGlobal: string; evidence: string[];
    claims?: ClaimPromotionAssessment[]; requiresHumanReview?: true; semanticAssessment?: "not-assessed";
    advisoryConfidence?: PageFrontmatter["confidence"]; publicationBody?: string; publicationSources?: string[] }>;
  pinsAffected: Array<{ pin: string; status: "kept" | "conflict" | "orphaned" }>;
  /** Counts per input check, not distinct pins; absent on legacy reports. */
  pinPersistence?: { applied: number; skipped: number };
  /** Known ledger omissions. Incomplete reports are review-only, never automatically applied. */
  scan?: { complete: boolean; unreadableAttempts: string[] };
}

export interface DreamResult {
  auxiliary?: AuxiliaryReport;
  outputRoot: string; // a NEW wiki directory; input untouched
  report: DreamReport;
}

export interface Dreamer {
  dream(input: DreamInput): Promise<DreamResult>;
}
