# AgentRig — Architecture & Build Order

**Name:** AgentRig, published as `@agentkitai/agentrig-{core,memory,supervisor,cli}`.
**Shape:** SDK core + thin CLI, TypeScript monorepo, four packages.
**Differentiators:** built-in supervisor loop (from AVO) and a dreaming memory system (from Anthropic's Managed Agents / Claude Code Auto Dream).
**Non-goals for v1:** competing with Claude Code/Codex on TUI polish; evolutionary search; multi-tenant hosting.

---

## 0. Design principles

1. **Event-sourced spine.** Every session is an append-only log of typed events. The CLI renders it, the supervisor watches it, the dream reads it, resume replays it. This single decision is what lets `memory` and `supervisor` be standalone packages: they depend on the event schema, not on the loop.
2. **Provider adapters normalize to one internal schema.** Core never sees an Anthropic or OpenAI payload. Two adapters from day one so the abstraction is real, not aspirational.
3. **Memory is an LLM Wiki.** Karpathy's pattern: immutable raw sources (sessions, docs) → an interlinked markdown wiki the agent owns → a schema doc that makes it a disciplined maintainer. Ingest / query / lint as the only operations. Inspectable, git-diffable, human-editable.
4. **Supervisor is out-of-band and cheap by default.** Heuristic detectors run on every event at ~zero cost; an LLM reviewer is invoked only when the policy escalates. It never blocks the loop; it steers at turn boundaries.
5. **Dreams never modify their input.** A dream produces a *new* store plus a change report. Default apply mode is review.

---

## 1. Package layout

```
packages/
  core/         agent loop, tool runtime, permissions, compaction, sessions, providers
  memory/       store format, scopes, retrieval, session-end extraction, dream
  supervisor/   detectors, policy ladder, interventions, reviewer, grader
  cli/          Ink TUI + headless commands over core's event stream
```

Dependency direction: `cli → supervisor, memory → core`. `memory` and `supervisor` depend only on `core`'s event/type definitions (consider splitting those into `core/types` or a tiny `protocol` package if that dependency gets heavy).

Tooling: pnpm workspaces, ESM, Node 22+, TypeScript strict, vitest, zod (schemas → JSON Schema for tool specs), changesets for publishing.

---

## 2. `core` — interfaces

### 2.1 Unified message schema

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { type: 'image'; mediaType: string; data: string };

interface Message { role: 'user' | 'assistant'; content: ContentBlock[] }
```

### 2.2 Provider adapter

```ts
interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  cacheHints?: { systemPrefix?: boolean };
}

type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error'; raw?: string };

interface ModelProvider {
  id: string;                          // 'anthropic' | 'openai' | 'gemini' | 'ollama' | ...
  model: string;
  capabilities: { tools: boolean; parallelTools: boolean; caching: boolean; contextWindow: number };
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens?(req: ModelRequest): Promise<number>;
}
```

Ship `anthropic` and `openai-compatible` (covers OpenAI, most local servers) in M2. Others are community/adapter work.

### 2.3 Tools

```ts
type PermissionClass = 'read' | 'write' | 'exec' | 'network';

interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;            // JSON Schema derived for ToolSpec
  permission: PermissionClass | ((input: I) => PermissionClass);
  paths?(input: I): string[];           // declared touched paths; enables cwd-confined policy rules
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

interface ToolContext { cwd: string; sessionId: string; emit(e: HarnessEvent): void; signal: AbortSignal }
interface ToolResult<O> { output: O; display: string; truncated?: boolean }
```

Built-ins for v1: `bash`, `read_file`, `edit_file` (search/replace), `write_file`, `glob`, `grep`. Memory tools come from `memory` and are registered like any other tool.

### 2.4 Permissions

```ts
interface PermissionRequest { tool: string; input: unknown; class: PermissionClass; cwd: string }
type Decision = 'allow' | 'deny' | 'ask';
interface PermissionPolicy { decide(req: PermissionRequest): Promise<Decision> }
```

v1: allowlist/denylist rules from config + `ask` fallback surfaced through the CLI. Rules can be
`cwdOnly`: they match only calls whose declared `paths()` all resolve inside the session cwd, so
file tools are confined to the project by default (bash declares no paths and cannot be confined
this way — its rules are all-or-nothing). Sandboxing (Docker/OS-level) is deferred; the policy
interface is where it plugs in.

### 2.5 The event spine

```ts
type HarnessEvent =
  | { type: 'session.start'; id: string; task: string; cwd: string; provider: string; ts: number }
  | { type: 'session.end'; reason: 'done' | 'aborted' | 'error' | 'budget'; ts: number }
  | { type: 'turn.start'; n: number } | { type: 'turn.end'; n: number }
  | { type: 'model.request'; tokensIn: number }
  | { type: 'model.delta'; text: string }
  | { type: 'model.response'; usage: Usage; stop: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown; inputHash: string }
  | { type: 'tool.result'; id: string; ok: boolean; display: string; durationMs: number }
  | { type: 'tool.denied'; id: string; name: string }
  | { type: 'file.changed'; path: string; op: 'create' | 'edit' | 'delete'; contentHash: string }
  | { type: 'permission.request'; req: PermissionRequest } | { type: 'permission.decision'; d: Decision }
  | { type: 'context.compact'; before: number; after: number }
  | { type: 'plan.updated'; items: PlanItem[] }
  | { type: 'subagent.spawn'; id: string; task: string } | { type: 'subagent.end'; id: string }
  | { type: 'steer'; source: 'user' | 'supervisor'; message: string }
  | { type: 'memory.note'; scope: 'project' | 'global'; path: string }
  | { type: 'supervisor.signal'; signal: Signal }
  | { type: 'supervisor.intervention'; intervention: Intervention }
  | { type: 'error'; message: string; fatal: boolean };
```

`inputHash` on `tool.call` and `contentHash` on `file.changed` exist specifically so loop/stall detectors are cheap string comparisons.

### 2.6 Agent + session

```ts
interface AgentConfig {
  provider: ModelProvider;
  tools: Tool[];
  permissions: PermissionPolicy;
  hooks?: Hook[];
  systemPrompt: string | ((ctx: PromptContext) => string);   // memory index is injected here
  budget?: { maxTurns?: number; maxTokens?: number; maxUsd?: number; maxMinutes?: number };
  compaction?: CompactionStrategy;
}

interface Session {
  id: string;
  events: AsyncIterable<HarnessEvent>;
  control: { steer(msg: string): void; pause(): void; resume(): void; abort(): void };
  done: Promise<SessionSummary>;
}

interface Agent { run(task: string, opts?: { cwd?: string; resume?: string }): Session }
```

Session persistence: one JSONL file per session under `.agentrig/sessions/<id>.jsonl` (events) + periodic snapshot of the message array for cheap resume.

### 2.7 Hooks

```ts
type HookPoint = 'user_prompt' | 'pre_model' | 'post_model' | 'pre_tool' | 'post_tool' | 'pre_compact' | 'session_end';
type HookResult = { action: 'continue' } | { action: 'deny'; reason: string } | { action: 'modify'; patch: unknown } | { action: 'inject'; message: string };
interface Hook { point: HookPoint; handler(ctx: HookContext): Promise<HookResult> }
```

`memory`'s session-end extraction and `supervisor`'s steering both land through hooks + `session.control`, not through special-casing in the loop.

### 2.8 Context management

```ts
interface CompactionStrategy {
  shouldCompact(usage: { tokens: number; window: number }): boolean;
  compact(messages: Message[], provider: ModelProvider, signal?: AbortSignal): Promise<Message[]>;
}
```

v1: summarize-older-turns when past 70% of window, keep last N tool results verbatim. Emits `context.compact`.

### 2.9 Subscription auth (experimental `openai-chatgpt` provider)

**Context.** The default provider auth is bring-your-own-key/endpoint (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `--base-url` to any OpenAI-compatible server). A ChatGPT Plus/Pro
subscription does **not** include API access; established third-party harnesses (OpenClaw,
Hermes) instead reuse the subscription through the same "Sign in with ChatGPT" **device-code
OAuth** flow that OpenAI's Codex CLI uses, then call a ChatGPT backend rather than
`api.openai.com`. This unblocks dogfooding on an existing subscription and is a real
"bring your subscription" feature.

**Decision (M2.5), pending the spike.** Add an **experimental, opt-in** `openai-chatgpt`
provider — never a default. It is gated behind an explicit `--provider openai-chatgpt` flag and
documented as experimental. Guardrails, all locked regardless of spike outcome:

- **OpenAI only.** Anthropic **explicitly prohibits** third-party use of Claude Pro/Max
  credentials, so there is deliberately no Claude equivalent. The docs must say why the two
  providers differ, rather than implying "bring any subscription."
- **Honest identification, never impersonation-by-default.** See the client-identity note below.
- **Undocumented backend.** The endpoint and protocol are reverse-engineered and unversioned;
  the provider tracks them best-effort and is expected to break. It never becomes core auth.
- **User's own account, eyes open.** OAuth is unsanctioned-but-not-known-prohibited for
  third-party tools (gray area); each user opts in for their own account. AgentRig never ships
  or logs subscription tokens; they live in the user's own config/env like any credential.

**Spike verdict (2026-08-29, from the Apache-2.0 `openai/codex` source).**

- **A new provider, not a variant of the M2 adapter.** The subscription-backed endpoint is
  `POST https://chatgpt.com/backend-api/codex/responses` — the **Responses API**, not Chat
  Completions. It requires `Authorization: Bearer <oauth access token>` plus an
  `originator: codex_cli_rs` header, a Codex `User-Agent`, and `ChatGPT-Account-ID`. So it needs:
  a Responses request/response mapper, SSE parsing, and a token-lifecycle manager (device-code
  login against `auth.openai.com`, plus **refresh with rotation persisted to writable storage**).
- **Client identity: AgentRig identifies itself.** The spike reported that the backend
  whitelists `originator` and 403s non-Codex values, and the first implementation copied
  `codex_cli_rs` on that basis. That was wrong: other third-party harnesses document sending
  their *own* "attribution headers" (`originator`, `version`, `User-Agent`), i.e. they
  self-identify, and nobody had tested whether an honest identifier is accepted. AgentRig
  therefore sends `originator: agentrig`. If the endpoint restricts to first-party clients,
  the resulting 403 is the correct answer to surface — claiming to be another vendor's client
  to defeat an access control is not something the harness does by default, and not something
  an autonomous agent should perform. The header is configurable for users who decide otherwise
  on their own accounts.
- **Effort:** medium — a new adapter (days to ~2 weeks); the token lifecycle and Responses
  mapping are the real work, portable from Codex since it is Apache-2.0.
- **Unattended cloud use:** a one-time device-code login yields a token bundle, but a *static*
  capture dies at access-token expiry (~hours); durable runs need us to refresh the (rotating)
  refresh token in writable storage with a single owner to avoid refresh races.
- **ToS:** OpenAI is currently **silent** (no explicit prohibition found; tacit "use your
  subscription wherever you like"); **Anthropic explicitly banned and server-side-enforced the
  equivalent for Claude in Jan–Feb 2026** — the live precedent that a vendor flips from silence
  to enforcement fast. This is a per-user, own-account judgment call, made with eyes open.

Status: spike complete; **build-vs-defer is a human decision.** It does **not** shortcut
dogfooding — a new adapter is days of work vs. minutes for metered credits — so it is a
deliberate "bring your subscription" feature, not the way to unblock M3.

---

## 3. `memory` — an LLM Wiki the agent maintains about the project

Follows Karpathy's LLM Wiki pattern (gist `442a6bf555914893e9891c11519de94f`): three layers (immutable raw sources → LLM-owned wiki → schema doc), three operations (ingest, query, lint), `index.md` + `log.md`, search as an optional tool. The harness's twist: **sessions are the primary raw source.** Every session is ingested into the wiki the way an article would be, and the dream is the pattern's lint pass, scheduled.

### 3.1 Three layers

```
.agentrig/
  raw/                       # immutable — the agent reads, never writes
    sessions/<id>.jsonl      #   event logs, append-only (written by core)
                             #   (<id>.snapshot.json / <id>.lock are core's mutable resume cache
                             #    and lock, NOT raw sources — ingest ignores them)
    attempts/<id>.json       #   attempts ledger extracted at session_end (3.5)
    docs/                    #   user-dropped sources: specs, ADRs, vendor docs, papers
  wiki/                      # LLM-owned — the human reads, the agent writes
    index.md                 #   catalog: every page, one-line summary, category. Read first on every query.
    log.md                   #   append-only chronology, parseable prefix: "## [2026-08-29] ingest | session 8f2a"
    overview.md              #   current synthesis of the project as the agent understands it
    sources/<id>.md          #   one page per ingested session or doc: what happened, what was learned
    entities/<slug>.md       #   modules, services, tools, commands, external systems, people
    concepts/<slug>.md       #   conventions, architecture decisions, recurring patterns, gotchas
    analyses/<slug>.md       #   filed answers: comparisons, investigations, root-cause writeups
    pins.json                #   human corrections that must survive regeneration (3.6)
  SCHEMA.md                  # the schema: page formats, naming, ingest/query/lint workflows. Co-evolves with use.
~/.agentrig/                  # global scope: same shape — its own raw/, wiki/, SCHEMA.md
```

Global is a **separate wiki**, not a label on project pages. Teams running the pattern at scale found audience labels drift and leak; compiling separately is the only reliable guarantee. Promotion to global = ingesting a project wiki page as a *source* into the global wiki, with provenance back to the project.

### 3.2 Operations

**Ingest** — triggered by the `session_end` hook, or `agentrig memory ingest <path>` for docs. Plan → reserve → generate → integrate:

1. Read the source under a *coverage plan*: bounded spans, each either inspected or explicitly closed as "nothing durable here", so a long session can't silently lose its middle when context runs out.
2. Propose page targets (create vs. update). Reserve them in `index.md` as `status: planned` placeholders using an atomic conditional write, with the LLM call *outside* any lock. Two concurrent sessions then converge on one `auth-module` page instead of forking `auth` vs `auth-module`.
3. Write the `sources/` page, update touched `entities/` and `concepts/` pages, update `index.md`, append to `log.md`. A single session may touch 5–15 pages.

Duplicate captures (`session_end` firing twice on a growing transcript) are detected by prefix comparison; only provably superseded snapshots are dropped — unique content is never deleted.

**Query** — the `memory_search` tool plus system-prompt injection. Index-first: `index.md` is in every system prompt; the agent picks pages, reads them, synthesizes. Recall fix from practice: return the **union** of index-selected pages and BM25 top-k over page bodies. Additive only, so recall can never regress below index-only. Answers worth keeping (a comparison, a root cause) are filed back into `analyses/` so explorations compound like sources do.

**Promotion is structural.** "Never promote anything derived from a single session" is enforced
by counting distinct `session:` refs in a page's frontmatter and fact-line provenance, not by
asking the model to respect it — one session's conclusion may be true only of that branch, that
machine, that afternoon.

**Lint = dream.** The scheduled dream runs the pattern's lint pass offline on a copy of the wiki: contradictions between pages, claims superseded by newer sources, orphan pages, concepts mentioned but lacking a page, missing cross-links, relative dates → absolute, references to files that no longer exist, index rebuilt lean. Output is a new `wiki/` directory plus a change report; the input is untouched; review or auto apply; promotion proposals to global. Never promote anything derived from a single session.

### 3.3 Page format

```markdown
---
type: entity | concept | source | analysis
slug: auth-module
aliases: [auth, AuthService]
sources: [session:8f2a, doc:adr-012]
updated: 2026-08-29
confidence: high | medium | low
---
- [stated] ... (session:8f2a)
- [observed] ... (session:9c11)
- [inferred] ... (dream:2026-08-28, from session:8f2a, session:9c11)
```

`[[wikilinks]]` between pages. Every fact line carries a tag and a source ref. **Shape, not value:** pages describe contracts, decisions, and reasons; they never copy volatile state (a SHA, a line count, a current version) — that is read live from the repo. Historical narrative ("v0.3 shipped with X") is the exception.

### 3.4 Store interface and tools

```ts
interface WikiPage { path: string; frontmatter: PageFrontmatter; body: string; updatedAt: number }

interface MemoryStore {
  root: string;
  scope: 'project' | 'global';
  index(): Promise<IndexEntry[]>;                                  // parsed index.md
  read(path: string): Promise<WikiPage | null>;
  write(path: string, page: Omit<WikiPage, 'updatedAt'>): Promise<void>;
  reserve(slug: string, claimant: string): Promise<'created' | 'exists'>;   // atomic placeholder
  appendLog(entry: string): Promise<void>;
  search(query: string, k?: number): Promise<Array<{ page: WikiPage; score: number; snippet: string }>>;
}

interface RawStore {  // append-only
  sessions(since?: number): Promise<SessionLogRef[]>;
  docs(): Promise<DocRef[]>;
  addDoc(path: string): Promise<DocRef>;
}
```

Tools exposed to the agent:

- `memory_search(query)` — index ∪ BM25, progressive disclosure
- `memory_read(path)`
- `memory_write(path, page)` — wiki only; `raw/` is not writable by the agent
- `memory_file_analysis(slug, body)` — file an answer back into `analyses/`
- `attempt_log(attempt)` — record a direction while it's fresh (lands in `raw/attempts/`)
- `memory_ingest(path)` — ingest a doc the user pointed at

An `Embedder` interface exists for optional vector search later; BM25 is the default and needs no API key.

### 3.5 Attempts ledger (the "every attempt incl. failures" requirement)

```ts
interface Attempt {
  id: string; sessionId: string; ts: number;
  hypothesis: string;            // what the agent was trying
  actions: string;               // 1–3 line summary
  outcome: 'success' | 'failed' | 'abandoned' | 'reverted';
  evidence: string[];            // event refs / error snippets / test output
  lesson?: string;               // filled by the agent, or by the dream
}
```

Lives in `raw/attempts/` (immutable). Ingest distills it into the session's `sources/` page and into `concepts/` when a lesson generalizes. This ledger is the supervisor reviewer's primary input.

### 3.6 Pins — human corrections survive regeneration

The sharp edge of "the LLM maintains everything": the next ingest of a related source regenerates a page and silently reverts a fix you made by hand. A pin records the *intent*, not the diff:

```json
{ "page": "concepts/retry-policy", "kind": "correction",
  "claim": "Retries apply per request, not per batch",
  "anchor": "## Semantics", "provenance": "human", "status": "active" }
```

After any regeneration, pins are re-checked against the new page text: still satisfied → keep; contradicted by a *newer source* → surface to the human instead of dropping; anchor section gone → flag orphaned. Storing the claim rather than a text diff is what lets re-application survive rewording.

### 3.7 Dream interface

```ts
interface DreamInput {
  wiki: MemoryStore;                  // read-only
  raw: RawStore;                      // sessions/docs since last dream (cap ~100 sessions)
  globalWiki?: MemoryStore;           // for promotion proposals
  provider: ModelProvider;
}

interface DreamResult {
  outputRoot: string;                 // a NEW wiki/ directory; input untouched
  report: {
    contradictions: Array<{ pages: string[]; claims: string[]; resolution: string }>;
    superseded: Array<{ page: string; old: string; new: string; source: string }>;
    orphans: string[];
    missingPages: Array<{ concept: string; mentionedIn: string[] }>;
    merged: Array<{ from: string[]; to: string }>;
    removed: Array<{ page: string; line: string; reason: string }>;
    promoted: Array<{ from: string; toGlobal: string; evidence: string[] }>;
    pinsAffected: Array<{ pin: string; status: 'kept' | 'conflict' | 'orphaned' }>;
  };
}

interface Dreamer { dream(input: DreamInput): Promise<DreamResult> }
```

Four phases, each its own prompt so they can be tested independently: **orient** (read `index.md`, `overview.md`, `SCHEMA.md`) → **gather signal** (scan raw sources since last dream: corrections, decisions, recurring errors, repeated workarounds, attempts with lessons) → **consolidate** (the lint fixes above, with provenance) → **prune & index** (rebuild `index.md` lean, demote verbose entries to pages, re-check pins).

Apply modes: `review` (default: the report as a diff, accept/reject per change — review the artifact, not the plan) and `auto`. Triggers: `agentrig dream`; `session_end` hook when ≥ N sessions or ≥ T hours since the last dream; cron.

The phases split by *cost*, not just by prompt: `orient`, `gather signal` and `prune & index` are
derivable from the wiki's own text and run with **no model call**, leaving `consolidate` as the
only phase that spends tokens. That is what lets the structural pass be free enough to run on
every session end (`agentrig memory lint` is exactly this pass, with the output copy discarded),
and it is why `--structural-only` needs no credential.

`auto` keeps the replaced wiki beside the new one as `wiki.before-dream-<stamp>`: a dream is a
bulk LLM rewrite of the agent's memory, so undo must be a directory rename rather than a restore
from a report.

### 3.8 Lore backend (optional)

[Lore](https://github.com/agentkitai/lore) is AgentKit's cross-agent memory server: Postgres +
pgvector, REST/MCP/SDKs, hooks for Claude Code/Cursor/Codex, knowledge graph, bi-temporal facts
with supersession, contradiction detection, review queue, workspaces. It overlaps AgentRig memory
on mechanics — capture at session end, prompt injection, contradiction handling, consolidation,
provenance, private→shared promotion — but not on the thesis: Lore's unit is a *memory* (an
embedded snippet in a database); the wiki's unit is a *page* (a synthesized, interlinked file the
agent maintains and a human reads, with zero infrastructure).

**Decision: the wiki is the source of truth; Lore is an optional backend behind a seam. The
default stays no-infra.**

```ts
interface MemoryBackend {
  id: string;
  onIngest(facts: DistilledFact[], source: SourceRef): Promise<void>;
  recall(query: string, k: number): Promise<BackendHit[]>;
  promote(page: WikiPage): Promise<void>;
  conflicts?(facts: DistilledFact[]): Promise<Conflict[]>;
}
```

Lore adapter mapping:

| AgentRig operation | Lore |
|---|---|
| ingest | `remember_observation` / `POST /v1/memories`, tagged `agentrig`, `project:<name>`, `page:<slug>`, `session:<id>` |
| `memory_search` | index ∪ BM25 ∪ recall (`/v1/retrieve`) — union only, never a replacement |
| promote to global | `promote_memory` (private→shared); global scope ↔ a Lore workspace |
| dream contradiction pass | consults Lore `conflicts` when connected; the wiki lint still runs |
| provenance | both ways: wiki fact lines carry `lore:<memory-id>`, Lore memories carry `agentrig:<repo>/<page>` metadata |
| auto-retrieval | Lore's auto-retrieval hook plugs into the `user_prompt` hook point |

Config: `LORE_API_URL`, `LORE_API_KEY`, `LORE_PROJECT`. Transport: Lore's REST API or the
`lore-sdk` npm package. Backend failures are logged and never block ingest, query, or dream.

Positioning: Lore is the shared memory service across agents and teams; AgentRig memory is the
per-project compiled knowledge the harness maintains, which can sync into Lore.

---

## 4. `supervisor` — interfaces

### 4.1 Signals & detectors (heuristic, LLM-free)

```ts
type SignalType = 'loop' | 'stall' | 'error_burst' | 'drift' | 'budget' | 'test_regression';
interface Signal { type: SignalType; confidence: number; evidence: string[]; window: [number, number] }

interface Detector {
  id: string;
  observe(event: HarnessEvent, state: SupervisorState): Signal | null;
}
```

v1 detectors:

| Detector | Fires when |
|---|---|
| `loop` | same `tool.call.inputHash` ≥ k in window; same error substring ≥ k; edit→revert pairs on one file ≥ 2 |
| `stall` | N consecutive turns with no `file.changed` and no new tool kind; or ≥ k test runs with unchanged pass count |
| `error_burst` | tool error rate over last M calls above threshold |
| `budget` | turns / tokens / USD / minutes past soft threshold (hard threshold is core's job) |
| `test_regression` | pass count drops vs. best seen this session |
| `drift` | files touched outside the plan's declared scope (v2: LLM-judged, sampled) |

### 4.2 Policy ladder & interventions

```ts
type Intervention =
  | { type: 'inject_guidance'; message: string }        // steer at next turn boundary
  | { type: 'force_replan' }                             // require a fresh plan.updated before more tool calls
  | { type: 'run_grader'; rubric: string }               // Outcomes-style check
  | { type: 'checkpoint_rollback'; toSeq: number }       // git-based, opt-in
  | { type: 'escalate'; question: string }               // ask the human
  | { type: 'abort'; reason: string };

interface Policy { decide(signals: Signal[], state: SupervisorState): Intervention[] }
```

Default ladder (per signal type, escalating on repeat): inject_guidance → force_replan → run reviewer → escalate → abort. Cooldowns prevent nagging every turn.

A rung is **skipped when the harness cannot perform it** rather than parked on, so one ladder
definition is correct at every milestone: in M4 (no reviewer, no pre-tool hook, and no human in a
headless run) it collapses to inject_guidance → abort, and it deepens on its own as M6 attaches a
reviewer and M7 lands the hook. `escalate` is available exactly when an `onEscalate` handler was
supplied — a headless run must never stop on a question nobody will answer. A signal held back by
its cooldown does not advance the rung, so suppression can never walk a session into `abort`.

### 4.3 Reviewer & grader (LLM-backed, invoked only by policy)

```ts
interface Reviewer {
  review(input: { task: string; trajectory: HarnessEvent[]; attempts: Attempt[]; memory: MemoryStore })
    : Promise<{ diagnosis: string; directions: string[]; guidance: string }>;
}
interface Grader {
  grade(input: { rubric: string; artifacts: FileRef[]; trajectory: HarnessEvent[] })
    : Promise<{ pass: boolean; gaps: string[] }>;
}
```

The reviewer is the AVO piece: review the whole trajectory (plus the attempts ledger, which AVO lacked), propose several candidate directions, hand back guidance. The grader is the Outcomes piece: a written rubric checked by a separate evaluator, which stands in for the objective score AVO had.

Several directions, not one, is the substantive part: a supervisor that returns a single
instruction has replaced the agent's judgement with its own on one sample, where candidates keep
the decision where the context is and let the agent recognise when none of them fit.

The two degrade in opposite directions on a malformed response, deliberately. The reviewer
returns empty guidance — a reviewer that says nothing merely costs a rung. The grader returns
`pass: false` — a grader that defaults to "yes" silently certifies everything, which is worse
than no grader at all.

`force_replan` needs `plan.updated`, which needs something to emit it: the `update_plan` built-in
tool (M6). `SessionControl.requirePlan(reason)` then makes the loop refuse every tool except
`update_plan` until a fresh plan lands. That gate is why the rung outranks `inject_guidance` —
guidance can be ignored and a gate cannot — and it is also what makes §4.1's `drift` detector
reachable, since it compares `file.changed` against the plan's declared `scope`.

### 4.4 Attachment

```ts
interface Supervisor {
  attach(session: Session, opts: { detectors: Detector[]; policy: Policy; reviewer?: Reviewer; grader?: Grader }): Detachable;
}
```

It consumes `session.events`, emits `supervisor.signal` / `supervisor.intervention` back into the log, and applies interventions through `session.control.steer()` and the `pre_tool` hook (for `force_replan`).

Two mechanics this needs from core, both added in M4 and both additive:

- **`SessionControl.record(payload)`** — the supervisor's own events go through core's single
  append chain, so `seq` stays one total order over the agent's events and the observer's. It
  accepts only `supervisor.signal` / `supervisor.intervention`: an observer must not be able to
  forge a `tool.call` or a `session.end`. Records after the session has ended are dropped, so
  `session.end` is always the log's last line.
- **`PlanItem.scope?: string[]`** — the `drift` detector compares `file.changed` against the
  plan's declared scope, which nothing carried before. With no item declaring a scope the
  detector is silent, so drift is opt-in by the agent's own plan rather than by config.

`Detachable` also carries `done: Promise<void>` so a shutdown path can join the observer instead
of racing it. The observer never blocks the loop: core's `EventStream` gives every consumer its
own cursor over a replayed buffer, so a slow detector delays interventions and nothing else.

---

## 5. `cli`

- `agentrig` — interactive Ink TUI: streams events, permission prompts, `/memory`, `/dream`, `/supervisor`, `/plan`, `/resume`
- `agentrig run "<task>" [--headless --json]` — scriptable; emits event JSONL to stdout
- `agentrig dream [--review|--auto] [--scope project|global] [--since <n>]`
- `agentrig sessions ls|show <id>|resume <id>`
- `agentrig memory ls|show|search <q>|ingest <path>|lint` (`lint` = a dry-run dream report, no output store)
- Config: `agentrig.config.ts` (provider, model, tools, permission rules, budget, supervisor thresholds) + `.agentrig/` state dir

Keep it thin: every command is a few lines over the SDK. If a feature needs CLI-only logic, it belongs in a package instead.

---

## 6. Build order

| M | Deliverable | Proves |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | the spine works before any model call |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | end-to-end task completion; start dogfooding on the repo itself |
| 2 | OpenAI-compatible adapter, compaction, resume | provider abstraction is real; long sessions survive |
| 2.5 | Experimental `openai-chatgpt` provider: device-code OAuth against a ChatGPT subscription (spike first — §2.9) | dogfood on an existing subscription instead of metered API credits; a real "bring your subscription" option |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest (coverage plan, reserve/placeholder), `index.md` injection, index ∪ BM25 search, attempts ledger, pins | every session compounds into the wiki; retrieval works index-first |
| 3b | Lore backend: `MemoryBackend` seam + Lore adapter (ingest push, recall union, promote, provenance both ways) | the wiki syncs into shared cross-agent memory without changing the no-infra default |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | stalls and loops get caught at ~zero cost |
| 5 | Dream = scheduled lint: contradictions, superseded claims, orphans, missing pages, new-wiki output + report, review/auto, promotion to global | the wiki stays trustworthy as it grows |
| 6 | Supervisor v2: reviewer over trajectory + attempts ledger, rubric grader, force_replan | the AVO loop, generalized |
| 7 | TUI, hooks API surface, MCP client, subagents, skills — in whatever order dogfooding demands | table stakes, driven by real need |

Exit criterion for each milestone: the harness is used to build the next milestone.

---

## 7. Decisions locked (defaults, change if you disagree)

- TypeScript / pnpm workspaces / ESM / vitest / zod
- Node: develop on 24 (Active LTS); `engines: >=22` as the floor until 22 reaches EOL (Apr 2027); adopt 26 once it goes LTS (Oct 2026)
- Own neutral message schema; adapters map outward
- JSONL event log per session; snapshots for resume
- Memory follows the LLM Wiki pattern; global is a separate wiki, not a label; index ∪ BM25 retrieval, embeddings pluggable; pins protect human edits; pages hold shape not volatile values
- Supervisor heuristics first, LLM only on escalation
- Dream = the wiki's lint pass, scheduled; output is a new directory + report; review mode default; single-session facts never promoted to global
- Lore is an optional `MemoryBackend`, never the source of truth; AgentLens is a future sink for the event stream (observability), not a memory dependency
- Provider auth is bring-your-own-key/endpoint by default; `openai-chatgpt` subscription auth (§2.9) is experimental and opt-in, OpenAI-only (Anthropic prohibits the equivalent), and never core auth

## 8. Open questions

1. Sandboxing: none + allowlists for v1, Docker later — acceptable?
2. Rollback: git-based checkpoints (`checkpoint_rollback`) require the workspace to be a repo; opt-in or assumed?
3. Which repo to dogfood on after AgentRig itself.
