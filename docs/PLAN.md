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
6. **Target workflow boundary (R19; not yet implemented).** The generic harness must not know about PRs, reviewers, landers, trains or rows. Shipping policy belongs in a ship pack built on generic contribution points; queue lifecycle and pluggable row stages belong in a train application. The migration and compatibility limits are defined by the [R19 contract](plans/R19.md).

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

R19's target layout adds a ship pack (workflow extension) above generic core/CLI contribution points and a train application above pluggable stages supplied by packs. This is a migration target, not the current package tree or an implementation-complete marker; see the [R19 contract](plans/R19.md).

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

R15c adds bounded `thinking` blocks with disclosed text and adapter-owned opaque
replay/signature/identity. Completed blocks are persisted in canonical messages;
the Responses provider no longer depends on a process-local replay cache. Cross-
format/unsupported Chat Completions histories explicitly refuse before fetch.
TUI verbosity reveals disclosed text only; export and textual ingest omit thinking
with an explicit receipt, while raw logs/ACP raw-event opt-in remain sensitive.
Compaction omits older-round thinking before summarization in the same operation,
preserving retained recent tool pairs and their signed reasoning verbatim after
the new advisory summary. See [R15c](plans/R15c.md) for bounds and cache limits.

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

Context windows use an exact per-provider/model table, with explicit named-entry
`contextWindow` taking precedence. The owner-confirmed `gpt-6-astra` window is
1,000,000 tokens on OpenAI and OpenAI ChatGPT. Other IDs remain **unknown** unless
added with a documented source; their compatibility fallbacks remain OpenAI 128,000,
Anthropic 200,000, and OpenAI ChatGPT 200,000 (not claims about those models).
Eviction and compaction both use the active provider's resolved capability window,
including when switching providers; no separate hard-coded compaction window exists.

Named entries (R3.5a): config may define `providers` (name → provider/model/baseUrl/contextWindow/
reasoningEffort) and `roles` (`main`, `supervisor`, `memory`, `subagents` → entry name). One
process then runs each role on its own entry; the flat `provider`/`model`/`baseUrl` keys remain
the implicit `default` entry. `reasoningEffort` is an adapter constructor option, never a per-request
field.

R10d adds explicit `doctor --probe` empirical tool/parallel/prompted-JSON/cache samples and
configuration-bound local observations consumed by CLI provider capabilities. Native strict
format support stays unknown; unknown dimensions retain labelled unverified configured fallback.
Plain doctor never probes. See [R10d](plans/R10d.md) for spend, usage and cache limitations.

### 2.3 Tools

```ts
type PermissionClass = 'read' | 'write' | 'exec' | 'network' | 'net';

interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;            // JSON Schema derived for ToolSpec
  permission: PermissionClass | ((input: I) => PermissionClass);
  effects?: 'read-only' | 'workspace' | 'background' | ((input: I) => 'read-only' | 'workspace' | 'background');
  hasBackgroundWork?(): boolean;       // trusted integration's live unfinished-writer probe
  paths?(input: I): string[];           // declared touched paths; enables cwd-confined policy rules
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

interface ToolContext { cwd: string; sessionId: string; emit(e: HarnessEvent): void; signal: AbortSignal }
interface ToolResult<O> { output: O; display: string; truncated?: boolean }
```

Built-ins for v1: `bash`, `read_file`, `edit_file` (search/replace), `write_file`, `glob`, `grep`. Memory tools come from `memory` and are registered like any other tool.
R11b adds `web_fetch`: bounded GET-only HTTP(S), explicit `net` permission, no redirects or
ambient credentials, text/plain or lexical HTML-to-text, external provenance. See
[R11b](plans/R11b.md) for byte/time/output bounds and trusted-host network limitations.

R15b adds opt-in configured post-edit diagnostics. Actual built-in mutation receipts trigger
one bounded literal-argv checker through ordinary exec authorization and sandboxing, while the
edit/checker pair remains exclusive. Internal audit calls never enter model tool registration
or replay messages. Optional diagnostics on the original result separate touched-file findings,
other-file errors and unknown/incomplete observations; zero findings are not correctness proof.
See [R15b](plans/R15b.md) for parser, output, cancellation and cooperative writer limits.

#### Opt-in skill bundles (R19a)

V1 skill frontmatter accepts `includes`, `assets`, and `flags` as **single-line JSON arrays**
(not YAML lists). Omitting these fields preserves legacy parsing and invocation. For example,
a `release/SKILL.md` may declare:

```yaml
includes: ["parts/checks.md", "parts/handoff.md"]
assets: ["assets/check.sh"]
flags: ["fresh-session"]
```

Every reference, including references in nested fragments, is relative to the entry skill's
containing directory. Paths are portable, normalized relative paths: ASCII letters/digits,
`_`, `-`, `.`, and `/` separators; no empty, `.` or `..` segments, absolute paths, drive prefixes,
backslashes, duplicate entries, or symlink components. Includes must end in `.md`. Fragments
are plain markdown or frontmatter with **only** `includes`; metadata/flags/generated provenance
cannot be inherited from fragments. Discovery expands depth-first in declaration order, then
appends the entry body, joining nonempty trimmed bodies with blank lines. A shared fragment
may appear more than once in a DAG; active-path cycles reject the whole skill. No partial skill
is published on missing, nonregular, oversized, invalid, or cyclic references; `onError` reports
why. The entry remains the catalogue name/description authority.

Limits: 32 references per field, 256 characters per path, 16 include levels, 64 include visits,
and the existing per-skill byte ceiling (256 KiB default) for entry plus bytes read from includes
and for the final composed body. Include reads also charge the existing 8 MiB root scan budget;
exceeding that budget discards the entire root, not a checked prefix. Each asset must be a
regular file under the same per-file byte ceiling. Discovery never reads asset contents or
executes assets: their absolute paths are appended under a labelled bundled-assets section so
slash activation and the `skill` tool receive the same resolved body. Ordinary tool permissions
still govern later asset access/execution. Installed package integrity checks remain in force.
Resolution snapshots include bodies at discovery/refresh; asset paths are references, not byte
snapshots. Filesystem validation does not create a sandbox against concurrent directory mutation.

`flags` currently admits only `fresh-session`; unknown/duplicate flags are invalid. Explicit TUI
slash invocation of a flagged skill refuses an existing conversation with a `/new` instruction;
it never silently discards history. This is a host invocation constraint, not a permission,
provider override, merge approval, or restriction on the model's ordinary `skill` read tool.
Refresh fingerprints include bundle metadata and the composed body. Existing skills opt in
only when their manifests change; the legacy `/topic` guard remains until R19e.

### 2.4 Permissions

The user-directed [unattended workflow amendment](plans/unattended-workflow.md)
supersedes R13c's mandatory fresh human consent under explicit CLI YOLO/skip-permissions.
Trusted SDK `approvalMode: "unattended"` keeps existing policy allows after external
input, preserves denials/audit/sandbox boundaries, and never opens human approval
callbacks. It does not itself grant policy authority. Interactive defaults retain
the fresh-consent guard. Provenance is unchanged; unattended mode accepts greater
prompt-injection exposure, not proof that external content is safe.

R16b captures bounded actual builtin edit/write before/after observations in
canonical tool results, distinct from labelled input-only permission proposals.
The CLI shares one bounded diff renderer without rereading files; unknown or
incomplete captures never claim a complete patch. Capture metadata is not model
input or tool authority. See [R16b](plans/R16b.md).

```ts
interface PermissionRequest { tool: string; input: unknown; class: PermissionClass; cwd: string;
                              paths?: string[]; origin?: string /* M7: a subagent's ask, routed to its parent */ }
type Decision = 'allow' | 'deny' | 'ask';
interface PermissionPolicy { decide(req: PermissionRequest): Promise<Decision> }
```

R12e adds explicit literal argv-prefix rules over trusted post-hook operation descriptors.
R12a adds optional live `AgentConfig.permissionGrants`: validated operation/resource/constraint/
duration records answer only base-policy `ask`, with grant/revocation events audited before
dispatch. Session/task lifecycle is enforced in the runtime; persisted events never restore
authority. TUI standing answers use the same registry and revoke at conversation boundaries.
See [R12a](plans/R12a.md) for advisory lexical scopes, shared-child compatibility pending R12d,
and bounded pending audit behavior. Explicit blanket permissions retain their authority.
R12b adds honest declared-effect/unknown summaries and explicit bounded path/argv scope editing
with a separate exact-scope preview and confirmation in the TUI. The proposal must cover the
current request using the same pure scope matcher as runtime enforcement. No effects are inferred
from names/prose/MCP hints; separate sandbox/MCP-change consent never becomes standing authority.
See [R12b](plans/R12b.md). Grant inspection/reasons and delegation remain R12c/R12d.
R12c adds live grant age/matched-decision counts and exact-ID revocation. Optional same-call
policy receipts identify actual rule/grant decisions without re-evaluation; unknown custom
attribution stays unknown. Correlated decision events drive chat/trace explanations, never
restore authority. Preview matches do not count as consumed grants. See [R12c](plans/R12c.md);
R12d adds task-sealed live child views, filtering ancestor grants by `delegable` without copying
records/counters. The runtime passes the exact view through subagent creation and the TUI asker;
child-owned approvals never authorize root or siblings. Explicit base-policy authority stays
shared and separate. See [R12d](plans/R12d.md) for bounds, expiry and trusted-host limitations.

v1: allowlist/denylist rules from config + `ask` fallback surfaced through the CLI. Rules can be
`cwdOnly`: they match only calls whose declared `paths()` all resolve inside the session cwd, so
file tools are confined to the project by default (bash declares no paths and cannot be confined
this way — its rules are all-or-nothing). Sandboxing (Docker/OS-level) is deferred; the policy
interface is where it plugs in.

### 2.5 The event spine

```ts
type HarnessEvent =
  | { type: 'session.start'; id: string; task: string; cwd: string; provider: string; ts: number }
  | { type: 'session.finishing'; reason: 'done' | 'aborted' | 'error' | 'budget'; ts: number } // runtime-only: model work settled, session_end maintenance still pending
  | { type: 'session.end'; reason: 'done' | 'aborted' | 'error' | 'budget'; ts: number }
  | { type: 'run.scheduled'; entryId: string; minute: number; source?: 'heartbeat' }
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
  | { type: 'subagent.spawn'; id: string; task: string }
  | { type: 'subagent.end'; id: string; reason?: 'done' | 'aborted' | 'error' | 'budget' }
  | { type: 'steer'; source: 'user' | 'supervisor'; message: string }
  | { type: 'memory.note'; scope: 'project' | 'global'; path: string }
  | { type: 'supervisor.signal'; signal: Signal }
  | { type: 'supervisor.intervention'; intervention: Intervention }
  | { type: 'error'; message: string; fatal: boolean };
```

`inputHash` on `tool.call` and `contentHash` on `file.changed` exist specifically so loop/stall detectors are cheap string comparisons.

R14a adds optional `PlanItem.accept`: a nonblank observable acceptance declaration of at most
1024 characters, shared by the event and update_plan tool schemas. The first actual model request
of each run (including resume) with that tool gives proportional planning guidance: multi-step
or risky work gets a plan with a check per item; straightforward queries can omit planning unless
explicitly required. Supervisor-required replanning remains enforced. This does not replace custom
prompts or manufacture fresh user consent. See [query effort](plans/query-efficiency.md).
Tool/session/plan displays retain declarations and mark missing or declared checks
unverified. Status done is not proof; evidence association/grading remain R14b/R14c. See [R14a](plans/R14a.md).

R14b adds internal foreground command outcome receipts to canonical tool results and a bounded
`SupervisorState.planEvidence` attempt view. Exact `<command> exits <integer>` declarations can
associate same-call observed exits; unsupported checks, missing receipts and incomplete attempts
remain unknown. Candidate observations never prove semantic acceptance. Latest failure/unknown
must not be hidden by an earlier matching exit. See [R14b](plans/R14b.md); grading remains R14c.

R14c shares that fold between `sessions show --evidence` and M6 claims-vs-evidence grading.
Current declared unfinished or unverified checks and incomplete views can only force a negative
verdict; matching exits never establish semantic proof or force pass. Dropped/legacy items remain
explicit without new legacy requirements. Attach supplies a bounded frozen current-run report,
not just recent history; resumed/fork runs name their starting sequence and prior history is not
assessed. CLI separately reads finished physical logs without models/config. See [R14c](plans/R14c.md).

R14d adds shared evaluator-attested regression/behavior lane reports over the existing E1 checks
and E2 reports. Actual surface observations and negative probes remain separate from pinned
regression and submitted tests. Partial/unknown/same-assumption evidence blocks, failures remain
failures, and pre-run exclusions remain SKIP. Optional trusted M6 evidence can lower but never
force a passing grade; no checks execute automatically. See [R14d](plans/R14d.md) for provenance
and cooperative evaluator limits; labels/digests are not proof of independence.

### 2.6 Agent + session

`subagent` accepts optional `outputSchema` in the same bounded JSON-Schema subset
as headless final output. It compiles a fresh prompted output contract per call,
uses the existing one tool-free repair under unchanged budgets, records
`output.validated` in the child log, and returns a validated parsed `output.result`
to the parent only on success. No schema preserves free-text behavior; a parent's
or supplied child config's final-output contract is not inherited. This is generic
shape validation, not acceptance of workflow claims. Ship's typed builder/fixer
handoff and independent verification/retry policy belong to the pack; the train
host's final conductor `{pr}` receipt is unchanged.

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

interface Agent { run(task: string, opts?: { cwd?: string; resume?: string; id?: string }): Session }
// `id` is a pre-allocated `store.create()` id, so a caller can log a session before it starts
```

Session persistence: one JSONL file per session under `.agentrig/sessions/<id>.jsonl` (events) + periodic snapshot of the message array for cheap resume.

R18b headless `agentrig run --resume <session>` continues that same session without a
new positional task. Modern committed-message logs take precedence over snapshot caches;
a run that crashed before its first snapshot is also resumable. Recorded plan and child
spawn/end observations are restored as advisory context. The conversation retains PR-ledger
read-back receipts and repair counters; ship/topic reconcile them with the live PR head
before acting. Core neither interprets phases nor grants authority from replayed text.
Legacy snapshot-only conversation details remain supported. Durable tool results and their
stored bounded displays are recovered before unknown-result placeholders; results precede
continuation text in the provider-independent conversation.

The resume ledger sums recorded token usage; with pricing configured, the agent reprices
those cumulative tokens. Without pricing, USD comes only from the cached snapshot and
can lag the log after a crash. A configured `maxUsd` cannot reconstruct that missing
dollar spend: token usage alone is not a dollar estimate.
This unpriced crash-accounting limitation means `maxUsd` is not a hard billing cap.

Mid-reply provider stream failures abort the uncommitted assistant turn (`turn.aborted`
with the provider error). Core discards partial text, reasoning and tool calls, then
re-requests the same history once per turn, at most three times per session run.
A second failure in a turn or exhausted recovery cap follows the fatal error path;
cancellation and ordinary budgets still bind. Observational deltas stay in the log,
but no partial assistant message is committed and no partial tool call executes.
Recovered responses have incomplete usage accounting because failed-attempt usage is
unknown. Child agents recover independently; subagent answer buffers discard aborted
turns and parent completion follows the child terminal outcome. Provider transport
retry policy is unchanged: it must never replay a consumed prefix.

`turn.aborted` marks only an attempt actually discarded for retry; fatal-uncommitted
output remains observable. CLI/AssistantText, live TUI, legacy materialization,
memory transcript ingest, CI and MCP captures discard only that attempt's buffered
text. Capture limits and omission flags roll back with it, not with completed text.
ACP/web stream speculative chunks immediately under the existing outstanding-write
reservations and frame limits. ACP has no chunk retraction: `turn.aborted` emits a
visible assistant notice marking the previous attempt abandoned and its partial
output to be discarded, before recovered text. This is not a completed log message
or a claim to retract already-sent chunks. Raw logs and `sessions show` remain lossless event timelines with
explicit abort markers. Evaluation closes discarded requests and their provider
retries as unknown usage, clears pending state, and treats the loop recovery marker
as informational rather than inventing tokens or another billed attempt.
Fatal provider stream failures (including pre-delta failures and recovery-cap exhaustion) emit
one fatal `error` before the matching `turn.end`, then `session.end` with the existing
classified reason (`error` for ordinary provider errors, `budget` for spend-cap failures,
or `aborted` when cancellation takes precedence); ordinary-budget exhaustion during a
failed stream also closes the turn before session end. A balanced `turn.end` promotes
fatal-uncommitted terminal subagent text to its answer buffer; only `turn.aborted`
discards an attempt. This is the delivered #472/#475 contract, not separately tracked work.

H6 keeps `agent.ts` as the model-loop coordinator. Internal `tool-execution.ts` owns the sequential
tool pipeline and registered-name emission authority; `session-lifecycle.ts` owns ordered event
delivery, pause/cancellation, orphan settlement and terminal resource release. Live plan state
and current turn/cwd are supplied explicitly. These are internal components, not new SDK or plugin
APIs; public exports and behavior stay unchanged. See [H6](plans/H6.md) for baseline trace checks.

R10a adds trusted SDK `AgentConfig.turnStrategy` for scheduling those pipeline calls;
exported `sequential` remains the default. The loop retains continuation/compaction/budget
handling, never passes truncated calls to a strategy, and preserves existing abort boundaries.
No arbitrary strategy loading or concurrency is enabled. See [R10a](plans/R10a.md).

R10b adds opt-in trusted SDK `parallel({ maxConcurrency })`: bounded declared read/write
hazard leases after final input validation, FIFO conflicts/exclusive barriers, serialized
authorization/prompts and joined pipelines. Unknown effects, hooks/checkpointers and active
background writers remain conservative exclusive cases. Sequential stays default; scheduling
is cooperative, not OS isolation. See [R10b](plans/R10b.md) for path and cancellation limits.

R10c adds trusted opt-in `subagentTool({ isolation: "worktree", ... })` on the same
strategy. Children get checked raw-baseline worktrees and return retained diff candidates;
the parent applies them only through separately authorized tools. Grants are not remapped,
enforcing parent sandboxes refuse host Git preparation, and cwd isolation is cooperative.
See [R10c](plans/R10c.md) for dirty/untracked coverage, retention caps and handoff limits.

R15l records the orchestration boundary: ordinary trusted user-authored SDK scripts
may compose these existing seams, bounded fan-out, independently specified checks
and serial separately authorized candidate application. They remain host programs,
not sandboxed model/config code; normal agent actions must use the runtime's
permission pipeline, never bypass it by calling tool callbacks directly. No workflow
engine/DSL/loader, automatic merge, exactly-once guarantee or new build row follows.
Failed, incomplete or stale evidence stops integration and retains artifacts; even
passing checks are evidence only for what they actually test. See [decision](plans/R15l.md).

#### Window-aware tool-result eviction

The default outbound-only policy keeps results verbatim while the estimated complete
input (system, messages and tool schemas, approximately characters / 4) is below
`toolResultEviction.thresholdFraction * provider.capabilities.contextWindow`.
`thresholdFraction` defaults to **0.5** and accepts finite values in `(0, 1]`.
Configure it via SDK `AgentConfig.toolResultEviction` or trusted CLI config/profile
`toolResultEviction`; the CLI forwards the policy to main and child agents.
At/above that threshold, replace the oldest eligible large results first, stopping
as soon as the estimated view is below it. Default minimum payload is **8 KiB**
(serialized JSON UTF-8 bytes); default protected turns in window mode is **0**.
Small, unmatched or provenance-tagged results remain intact; if these or non-tool
context alone exceed the threshold, eviction cannot guarantee fitting the window
and normal compaction still applies. Session logs/history are never rewritten.

Compatibility overrides: `enabled: false` disables eviction; explicitly setting
`keepLastTurns` or `minBytes` without `thresholdFraction` selects the prior age-based
policy (legacy defaults **5 turns / 8 KiB**). Set `thresholdFraction` explicitly to
combine those size/recency overrides with window pressure instead. Direct SDK
`evictToolResults` calls without a pressure estimator retain the legacy policy.
Compaction's zero-usage fallback estimates this same evicted view; its trigger stays
70% of the resolved provider window and reported usage still takes precedence.

### 2.7 Hooks

R19a's first generic-mechanism slice adds extension hook points `pre_spawn` and
`post_spawn`. `HookContext.spawn` carries the exact submitted task, parent session
ID and optional immutable selected-role provenance (declared tools, not a rewritten
policy). Post additionally carries the launched child's ID. Pre runs before child
configuration/start, provisionally reserves shared capacity during the asynchronous
gate, accepts only `continue`/`deny`, and fails closed on hook errors/timeouts or
unsupported results. Post follows the existing spawn emission and is observational;
its failures cannot erase or strand the child. Neither point permits modification or
injection. With no registered spawn hooks, existing dispatch remains unchanged.

The public `querySpawnLog(store, parent, { childId?, role? })` reads physical immutable
`subagent.spawn` events in append order without fork-ancestry expansion, live state,
backfills or writes. Strict log decoding propagates corruption/incomplete writes.
The optional additive event field `taskText` records exact submitted input; existing
`task` retains display-label semantics, and old events may lack `taskText` or role.
No new event type or renderer behavior is introduced by the spawn-hook slice. The
provider-bound role slice is recorded in the R19 plan; skill includes/assets/flags are
specified in §2.3. Final R19a completion remains conductor-owned.

```ts
type HookPoint = 'user_prompt' | 'pre_model' | 'post_model' | 'pre_tool' | 'post_tool' | 'pre_spawn' | 'post_spawn' | 'pre_compact' | 'session_end';
type HookResult = { action: 'continue' } | { action: 'deny'; reason: string } | { action: 'modify'; patch: unknown } | { action: 'inject'; message: string };
interface Hook { point: HookPoint; handler(ctx: HookContext): Promise<HookResult> }
```

`memory`'s session-end extraction and `supervisor`'s steering both land through hooks + `session.control`, not through special-casing in the loop.

Three properties make the surface safe to extend through, all of them the difference between a
hook system and a footgun: a handler that **throws** is reported and skipped, a handler that
**hangs** is timed out, and a `modify` patch is **re-validated** against the schema it is patching
before it is applied. A hook is third-party code, so its patch is a proposal rather than an
instruction. Each point declares which actions it accepts — `session_end` takes only `continue`,
because the session is already over — and the first `deny` stops the chain.

R4a adds opt-in `hooks: [new Checkpointer()]` for pre-mutation Git snapshots. This built-in
safety hook runs separately after final permission approval and fails closed on errors/timeouts.
Permission classes do not establish tool effects: only trusted `read-only` declarations skip it;
unknown effects and foreground shell calls require capture. Raw worktree trees are retained under
`refs/agentrig/worktrees/<sha256(canonical-git-dir)>/<session>/<turn>` with `checkpoint.created` events; non-Git directories receive a
`checkpoint.warning`. HEAD, index and worktree are unchanged. The cooperative writer lease,
background-work refusal, coverage exclusions and host quiescence preconditions are specified in
[R4a](plans/R4a.md). R4b exposes opt-in config `checkpoints: true` in run/TUI
(the user-directed correction restores opt-in after R17b enabled it implicitly),
subject to the existing host-hook sandbox restriction. It tracks stable post-tool ownership,
rejects later external edits, and records `checkpoint.sealed` at a quiescent session end.
`undoSession` powers `sessions undo <id> [--to-turn n]` and idle TUI `/undo [turn]`: require a
closed latest run, matching seal/current raw tree/HEAD/index, then restore only differing covered
files. Displaced originals and a manifest remain in a Git-metadata recovery directory;
`checkpoint.restored` goes to a separate audit log, never rewriting the original conversation.
Older unsealed runs refuse. TUI starts a fresh conversation after undo; explicit resume does not
replay tools. See [R4b](plans/R4b.md) for cooperative-writer and partial-failure limits.
Supervisor restoration remains R4c.

The user-approved worktree correction supersedes R4a's repository-wide lease:
locks and new refs are worktree-local, preserving independent parallel agents.
Same-worktree ownership, external-change refusal and undo checks remain. Legacy
refs stay readable and retained shared locks require explicit recovery, not silent
bypass. See [worktree checkpoints](plans/worktree-checkpoints.md) and
[recovery](CHECKPOINT-RECOVERY.md) for upgrade and cooperative-writer limits.

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

Ordinary-session correction: CLI automatic session-end capture now uses a bounded
latest-run spending heuristic and 30s/15s-per-call/4-call defaults. Successful
read-only queries and captures whose complete evidence cannot fit defer visibly,
retaining raw logs for explicit manual ingest. This is not a claim that those
conversations have no durable knowledge. Manual ingest and SDK hook defaults remain
unchanged; explicit limits override. See [contract](plans/ordinary-session-flow.md).

1. Read the source under a *coverage plan*: bounded spans, each either inspected or explicitly closed as "nothing durable here", so a long session can't silently lose its middle when context runs out.
2. Propose page targets (create vs. update). Reserve them in `index.md` as `status: planned` placeholders using an atomic conditional write, with the LLM call *outside* any lock. Two concurrent sessions then converge on one `auth-module` page instead of forking `auth` vs `auth-module`.
3. Write the `sources/` page, update touched `entities/` and `concepts/` pages, update `index.md`, append to `log.md`. A single session may touch 5–15 pages.

Duplicate captures (`session_end` firing twice on a growing transcript) are detected by prefix comparison; only provably superseded snapshots are dropped — unique content is never deleted.

**Query** — the `memory_search` tool plus optional system-prompt injection. R17f makes automatic `index.md` injection opt-in in the recommended CLI profile (`memoryIndexInjection: true`); explicit retrieval remains available, and direct SDK callers retain their unspecified-option behavior. When injected, the index lets the agent pick pages, read them and synthesize. Recall returns the **union** of index-selected pages and BM25 top-k over page bodies. Additive only, so recall can never regress below index-only. Answers worth keeping (a comparison, a root cause) are filed back into `analyses/` so explorations compound like sources do.

R17e makes both halves of retrieval visible: a recall renders as the page and the claim that
matched rather than a result count, and the index injected into the system prompt announces itself
in the transcript. `memory` owns the retrieval display format on both sides (written and read back
in one module), so returned backend text cannot forge a page entry, and a failed or denied call
renders no recall claim at all.

**Promotion is structural.** "Never promote anything derived from a single session" is enforced
by runtime-backed, claim-level evidence, not citation counts (H4). Every claim needs at least two
independent located observations from validated immutable session logs. Related lineage and
copied result payloads count once. The initial conservative support rule requires an exact textual
line in complete recorded tool output; paraphrases without that support remain ineligible.
This is structural eligibility for human review, not semantic proof. Reports show source events,
character ranges, hashes and excerpts; page confidence is advisory. Dream validates final pages
and only proposes promotion. `memory promote` previews; `--confirm` rechecks and publishes only
checked claims/references, never unsupported prose or extra unverified citations. Backend adapters
remain trusted transport primitives. See `docs/plans/H4.md` for limits and trust assumptions.

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

R6d adds advisory, model-free write-quality findings to lint/dream: prose calibration of inferred
claims, temporary status outside source history, exact repeated claims, thinly cited universal
observations and explicit subject-link routing. Missing provenance tags are reported for review.
New ingest summaries are inferred model synthesis, not observed evidence. No quality finding
automatically edits or promotes a claim; tags/citation counts are not semantic verification.
See [R6d](plans/R6d.md) for heuristic limits and controls.

R6e separates `assessPromotionEvidence` (offline evidence-only previews) from `selectForPromotion`
(evidence plus effect approval). `reviewPromotionEffects` makes one bounded model call over exact
candidate artifacts and mints process-local receipts; missing, copied, changed or uncertain
receipts refuse. Any weakening of verification, scrutiny, failure disclosure, review, workaround
scope or honest reporting refuses the whole candidate without a replacement lesson. Model effect
assessment is fallible and never replaces human confirmation or H4's runtime witnesses.

`memory promote` previews offline; `--confirm` also requires the bounded memory-role assessment
and fresh page/evidence validation before backend publication. `--guardrail-limits` controls its
limits. A full dream with an eligible global candidate uses at most one additional batch call;
its default total call ceiling is two, sharing accounting and cancellation. Structural-only
dream remains zero-call and reports unassessed candidates as refused. [R6e](plans/R6e.md) records
the exact contract and limits. Generated skills are a later row in ROADMAP §5's committed queue.

```ts
interface WikiPage { path: string; frontmatter: PageFrontmatter; body: string; updatedAt: number; version?: string }

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
- `memory_write(type, slug, body, if_version?)` — wiki only; `raw/` is not writable by the agent.
  Replacement requires the content version from `memory_read` or the last write receipt;
  absent/null is create-only. Tokens are the first 128 bits of SHA-256 over persisted bytes.
  A stale response returns the current page/version for intentional merge and retry. The same
  rule applies to `memory_file_analysis`. Version-aware reads hash persisted bytes, not mtime.
- `memory_file_analysis(slug, body, if_version?)` — file an answer back into `analyses/`
- `attempt_log(attempt)` — record a direction while it's fresh (lands in `raw/attempts/`)
- `memory_ingest(path)` — ingest a doc the user pointed at

H5a's `FileMemoryStore.compareAndSwap()` serializes version checking and replacement across
cooperating processes; metadata defaults can be derived from that checked state in a synchronous
transform. Optional index updates share that lock and finish after a committed page even if
cancellation arrives. Index/release failures are explicit warnings, not a false uncommitted result.
`update()` runs a synchronous
transform under the mutation lock. The original SDK `write()` remains a trusted unconditional
replacement, not a safe read-modify-write API. Index additions, reservations and log appends are
serialized too. Locks have bounded waits and no age-based stealing; crashed-owner recovery requires
stopping writers before removing the named lock. Human/external file edits and multi-file crash
atomicity are outside this cooperative lock contract. H5b/H5c migrate ingest/dream callers.

`WikiPage.extraFrontmatter` retains unknown human metadata as opaque lines. Guarded updates/CAS
preserve it when omitted; an explicit empty string clears it. The trusted `write()` replacement
requires callers to pass any metadata they want retained. Dream retains metadata-bearing merge
sources rather than guessing cross-page metadata precedence. See
`docs/plans/H5-memory-persistence.md` for multiline fact boundaries and persistence limits.

An `Embedder` interface exists for optional vector search later; BM25 is the default and needs no API key.

### 3.5 Attempts ledger (the "every attempt incl. failures" requirement)

Session-scoped reads use disposable `.agentrig/attempt-index.json` with a separate bounded rebuild
and a shared writer lock; raw records remain immutable. New records are capped at 64 KiB before
claiming their ID. Oversized/torn legacy entries remain visible as unreadable, not silently absent.
Reviewer input can proceed with a partial-history warning; dream's automatic-apply completeness
gate is unchanged. Explicit `FileRawStore.rebuildAttemptIndex()` supports operator-selected scan
limits and must be called after out-of-contract in-place raw repair. See the H5 persistence plan
for cache caps, cooperative-writer assumptions and exact rebuild/query budget separation.

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

R4c optionally restores after a supervisor-requested abort: `abortRestores: true` plus a trusted
`restoreCheckpoint(sessionId, signal)` seam. The supervisor imports only core types; CLI/TUI
provide guarded `undoSession` and require explicit trusted config `supervise: true` and `checkpoints: true`, plus
`--supervisor-abort --supervisor-abort-restores` (or equivalent trusted config).
Implicit recommended defaults cannot authorize destructive restore. Restoration waits for an aborted
`session.done`, never overrides R4b ownership checks, and is joined by observer `done` even after
cleanup detach. User abort alone does not trigger it. The restore signal has a 60-second budget;
trusted destructive callbacks must cooperate and settle, not be abandoned while still mutating.
Reports use the UI/stderr and separate undo audit, not events after the original `session.end`.
TUI clears automatic resume state after success. See [R4c](plans/R4c.md); this does not implement
the independent mid-session `checkpoint_rollback` rung.

R17e separates the decision from its effect, because the observer records an intervention *before*
it applies one: `supervisor.intervention` gains an `id` and `noticed` (the signal the policy acted
on), and a new `supervisor.outcome` record reports `queued` / `applied` / `no-action` /
`unavailable` / `failed` with a cost. Queued is not applied — the `steer` event is the only receipt
that guidance reached the model — and an LLM-backed rung's cost names its `auxiliary.usage` record
instead of restating consumption that may be unknown. Both are `SupervisorRecord` variants, so the
observer's write gate is unchanged. See [R17e](plans/R17e.md) for the rendering and its limits.

A rung is **skipped when the harness cannot perform it** rather than parked on, so one ladder
definition is correct at every milestone: in M4 (no reviewer, no pre-tool hook, and no human in a
headless run) it collapses to inject_guidance → abort, and it deepens on its own as M6 attaches a
reviewer and M7 lands the hook. `escalate` is available exactly when an `onEscalate` handler was
supplied — a headless run must never stop on a question nobody will answer. A signal held back by
its cooldown does not advance the rung, so suppression can never walk a session into `abort`.

### 4.3 Reviewer & grader (LLM-backed, invoked only by policy)

H5d bounds these calls and passes cancellation through loaders/providers. Core's optional
`SessionControl.auxiliarySignal` ends observer work before independently budgeted session-end
hooks; detach also cancels idle waits. Validated `auxiliary.usage` records carry a run ID,
cumulative `AuxiliaryReport` and `final` flag. Replace snapshots by ID, never sum them or fold
them into main-model totals. An unfinished snapshot keeps total consumption/cost unknown when
the log closes; `session.end` remains its final event. CLI/TUI render final and unfinished usage
separately. See `docs/plans/H5-auxiliary-lifecycle.md` for defaults, SDK options and the limits of
cancelling uncooperative JavaScript/remote work. E2's bounded evidence-bundle report keeps main,
child and auxiliary consumption explicit and prices only supplied role/provider/model rates;
see `docs/EVALUATION-REPORTS.md`. Missing collector coverage remains unknown. Optional
`model.response.usageComplete` distinguishes new reported-zero calls from synthesized/missing
usage; legacy absence is conservative unknown, never a schema incompatibility.

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
`update_plan` until a fresh plan lands. Two safeguards are part of the design rather than
afterthoughts, because a gate that cannot be cleared is worse than the loop it interrupts: the
rung is offered only when the session actually has a plan tool (`control.canRequirePlan()`), and
the gate releases itself after a couple of refusals with an `error` explaining why. That gate is why the rung outranks `inject_guidance` —
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

R19d moves queue/row execution to `@agentkitai/agentrig-train` with injected stages.
The CLI composes it with `@agentkitai/agentrig-ship/train`; ship owns prompts,
receipts, pre-check/landing policy and train host preflight. The optional
`train/runtime` adapter uses public core ledger/session/message APIs for usage and
receipt decoding. Core has no train modules/exports or train/ship dependency.
`train <dir>` and `usage --row/--train-dir` preserve flags and directory contracts;
see [train operations](TRAIN-OPERATIONS.md). This is ownership extraction, not
R19e builder-role or TUI retirement.

R16h adds startup-captured strict `tui` settings: fixed dark/light palettes and
bounded permission/history/abort keys. NO_COLOR overrides TUI styling; fixed
Ctrl+C/Escape and paste/protected-prompt guards remain. No runtime editor or
arbitrary terminal code. See [TUI settings](TUI-SETTINGS.md).

R16g adds idle-only manual TUI commands: `/clear` aliases `/new`; `/doctor` runs
plain local diagnostics with provider probes disabled; `/diff [checkpoint [turn]]`
captures protected tracked worktree changes against HEAD or a validated recorded
checkpoint. Doctor and diff require sandbox `none`; no host-side sandbox bypass.
Neither dispatches a model. Diagnostic filesystem probes are joined, not forcibly
cancellable. Diff uses read permission, bounded Git output and identity rechecks;
untracked files and binary contents are explicitly excluded.

`/compact` invokes `Agent.compact({resume, cwd?, signal?})`, not a normal user turn.
It creates a maintenance fork and adopts it only after canonical log/snapshot
verification; the original history remains unchanged, and failed children remain
unadopted diagnostic artifacts. One summary call, at most 1024 requested output
tokens (or the smaller configured bound), 256 KiB streamed summary and at most
60 seconds cooperative provider/hook deadline. Parent loading and filesystem
publication are joined, not hard time/RSS containment. Existing total-token/USD
caps refuse; configured project-estimate ledger admission stays active. No ordinary
model loop, tools, supervisor, output repair, user-prompt/session-end hooks or memory
maintenance runs. Retained content/provenance and opaque reasoning remain intact.
The printed delta is a transcript-only UTF-8 byte/estimated-token comparison,
excluding system/tools; the next ordinary request emits its real manifest.
[Contract and controls](plans/R16g.md).
R15k adds explicit TUI `@path` reads and Ctrl+V clipboard images, bounded metadata
completion with one-time policy approval, and advisory source-labeled content
through the normal core read pipeline. Canonical logs retain sensitive payloads;
input history retains references only. See [attachments](ATTACHMENTS.md).

R16d adds interactive-only prompt recall, slash-name completion and multiline
composition without changing paste-safe quiet-point dispatch. Trusted projects
retain bounded `.agentrig/history` outside raw/ingest inputs; untrusted launches
remain memory-only. Approval/question/escalation input is excluded. See
[R16d](plans/R16d.md) for privacy, storage limits and terminal compatibility.
The slash-discovery follow-up adds an automatic bounded menu while typing the
initial `/token`: skills first, arrow selection, Tab fill, explicit Enter execution.
It shares the composer row budget and remains inactive for framed pasted content
and protected answers. See [slash suggestions](plans/slash-suggestions.md).
R8d adds an authenticated, exact-loopback reference web page over the existing ACP
server/controller. Fixed assets, bearer plus Host/Origin checks, bounded WebSocket
queues and joined connection ownership are explicit; authentication is not project
trust or execution permission. See [local web client](WEB.md) and [R8d](plans/R8d.md).

R8c adds explicit `--otel-endpoint` observation over the event stream, with fixed
metadata-only OTLP/HTTP JSON spans, shared bounded process capacity and joined
shutdown. It never grants model authority or changes immutable event ordering;
enforcing no-network sandboxes refuse export. See [OTLP traces](OTEL.md).
R15f adds explicit `run --ci` file/event input as advisory context, configured
headless policy and actual ask-deny cancellation. Fixed CI ceilings clamp larger
settings without claiming aggregate billing containment. Create-only Markdown
reports and optional authorized, identity-checked PR comments never rewrite logs
or automatically execute event code. See [CI mode](CI-MODE.md) and [R15f](plans/R15f.md).
R15a adds the private-runtime `ask_user` builtin and protected question events.
TUI and explicitly negotiated ACP clients answer through a bounded clarification
queue, separate from permissions and supervisor steering. Headless defaults fail;
explicit first-option/literal-file policies remain externally sourced automation.
Explicit unattended mode suppresses the human callback; the separate trusted
`onUnattendedQuestion` seam preserves configured noninteractive answers, rejects
human-labelled replies, and otherwise fails required questions promptly.
Answers never mint grants or clear external-input restrictions. See
[questions](QUESTIONS.md) and [R15a](plans/R15a.md) for bounds and lifecycle controls.

R8b adds `mcp-serve`: four bounded tools over official modern/legacy stdio MCP,
reusing the controller and trusted launch configuration. Client tasks remain
advisory; no execution consent is inferred. Read tools use configured stores and
policy. Cancellation joins owned work and transport reservations cover queued
responses. See [MCP serving](MCP-SERVE.md) and [R8b](plans/R8b.md).

R8a adds stable ACP v1 stdio over the headless controller: literal prompts, streamed
updates and one-time permission replies. Resource links remain separately advisory;
client MCP configuration must match trusted host entries with existing unchanged
pins. Per-session cwd/trust, queue bounds and cleanup are described in [ACP](ACP.md)
and [R8a](plans/R8a.md). No second bespoke protocol, v2 or listening service.

R7a adds bounded plain-JSON schedules with five-field UTC cron. `schedule tick` previews
without provider/config loading; `--execute` requires trusted project consent and preserves
advisory scheduled provenance through `run.scheduled`, never fresh user permission. Claims
serialize cooperating ticks, no daemon/catch-up. R15i remains required before unattended
execution is enabled by default. See [R7a](plans/R7a.md) for bounds and crash/race limits.

R7b adds advisory `HEARTBEAT.md` fallback only when no cron matches the tick minute.
Preview stays offline; trusted explicit execution shares the existing lock and durable minute
claim. Empty checklists have one request and an empty runtime tool registry. Heartbeat disables
extensions, skills/packages, MCP, subagents, maintenance, checkpoints and supervision even
when explicitly configured. Log, derived cache and claim are allowed operational metadata;
no task/wiki/report artifacts for empty/no-action runs. See [R7b](plans/R7b.md).

R7c adds bounded operational scheduled receipts and next-trusted-startup failure notices.
Ordinary cron launches reuse configured ingestion once (explicit false wins); its trusted
runtime source directory follows the actual SessionStore, including custom memory roots.
Heartbeat success stays quiet and maintenance-free; failures may write operational failure
accounting, not task/wiki artifacts. Acknowledgement follows actual Ink mount and covers only
the displayed snapshot. Missing receipts leave a fixed uncertainty marker, never silently
cleared or used to retry execution. Main/auxiliary usage and unknown cost remain distinct.
See [R7c](plans/R7c.md) for retention, accounting and cooperative crash/recovery limits.

R17e adds idle-or-running `/why`: a local fold over the events this process already received that
explains the guidance actually injected into the last turn — its origin, the supervisor decision and
signal behind it, its cost — plus the automatic memory context and the memory tool results the sent
request carried, read from that turn's `context.manifest`. Queued-but-undelivered guidance is
reported as such, never as injected. No provider call, no file read; it resets with the
conversation. See [R17e](plans/R17e.md).

- `agentrig` — interactive Ink TUI: streams events, permission prompts, `/memory`, `/dream`, `/supervisor`, `/plan`, `/why`, `/resume`
- `agentrig run "<task>" [--headless --json]` — scriptable; emits event JSONL to stdout
- `agentrig dream [--review|--auto] [--scope project|global] [--since <n>]`
- `agentrig sessions ls|show <id>|resume <id>`
- `agentrig memory ls|show|search <q>|ingest <path>|lint` (`lint` = a dry-run dream report, no output store)
- Config: `.agentrig/config.json` (provider, model, tools, permission rules, budget, supervisor thresholds; `providers` named entries + `roles` per-role selection) + `.agentrig/` state dir

Keep it thin: every command is a few lines over the SDK. If a feature needs CLI-only logic, it belongs in a package instead.

---

### 5.1 Trusted host CLI packs and public construction API (R19b slice)

`@agentkitai/agentrig-cli` is an import-safe public module as well as an executable.
Importing the root never parses the importing process's argv. Direct and symlinked bin
invocation still run the CLI. Import the package root, never private `dist/*.js` helpers.

A trusted host supplies `buildProgram({ packs: CliPack[] })`. Each pack has `name`,
`summary`, and nonempty `commands`; each command has `name`, `summary`, and
`run(argv, context)`. This is **explicit host code registration**, not project config,
extension discovery, an install-time hook, or a sandbox. No filesystem loader is added;
existing installed-package/extension discovery is unchanged.

Pack commands live under `<pack> <command> [args...]`; option-like operands require `--`.
Unknown options/commands fail through Commander. Entire batches validate strictly before
registration: at most 32 packs, 1–64 commands per pack, ASCII names matching
`[a-z][a-z0-9-]{0,31}`, 1–200 character summaries rejecting line breaks, C0/C1 controls and
Unicode embedding/isolation controls, function handlers, no unknown fields. Duplicate namespaces
or commands and collisions with builtins, their aliases, or `help` are errors. Builtins
are never shadowed. Handlers receive copied operands and `{ profile?, print(text) }`,
not a mutable Commander tree. Profile is the root/inherited selection, not resolved or
trusted config. `print` uses Commander's output sink. Async completion/errors propagate.

```ts
import { buildProgram, type CliPack } from "@agentkitai/agentrig-cli";
const pack: CliPack = {
  name: "fixture", summary: "Fixture commands",
  commands: [{ name: "echo", summary: "Echo operands",
    async run(args, { print }) { print(args.join(" ")); } }],
};
await buildProgram({ packs: [pack] }).parseAsync(process.argv);
```

The public root also exports these existing helpers without changing their semantics:
- `buildRoleProvider(options, role, hooks?)`: constructs only one runtime role's provider,
  validating all bindings. Roles are `main | supervisor | memory | subagents`, not external
  skill role labels. `buildProviders` constructs the full set; `resolveProviderEntries`
  resolves names without construction. Credentials, concurrency and daily-cap refusals
  remain unchanged. Construction itself does not make a model request.
- `resolveChildEnvironment(options?)`: trusted user profile overlay onto cloned inherited
  env. Only user profiles supply environment values. Trusted project config may be read
  to validate profile names but never supplies environment authority. Explicit profile
  beats inherited `AGENTRIG_CHILD_PROFILE`; home/project trust boundaries remain unchanged.
- `resolveProjectChecks(projectRoot, profile?, user?)`: validates/returns project `checks`
  (including profile selection and declared test-timeout expansion) or `undefined`. User
  config may validate profile names, never supply commands. Does not execute commands,
  grant trust or load plugins.
- Types: `ProgramDependencies`, `CliPack`, `CliPackCommand`, `ProviderOptions`,
  `ProviderHooks`, `ProviderSet`, `ConfigFile`, `ProjectChecks`, `Role`, `ProviderEntry`, `Roles`.

**R19b config slice:** A trusted host can add `configSchema: z.object({...}).strict()`
to a `CliPack`. Config files use `packs.<pack-name>`; undeclared namespaces, wrong
value types and unknown keys fail in `parseConfigText`/`readConfigFile` before
handler dispatch. Nested objects follow the pack's declared schema (pack authors
must use strict nested objects where unknown nested keys should be rejected).
Config never imports pack code or grants trust. The optional schema is absent for
command-only packs, which cannot receive a config namespace. Core runtime
extensions remain independent and unchanged.

The public config readers accept `ConfigReadOptions` (`packs`, optional
`onWarning`); `resolveProjectChecks` accepts the same options as its fourth argument; `buildProgram` wires its explicit packs into user/project reads and
child-environment preAction validation. Handlers receive their parsed namespace
as `context.config`; config-bearing namespaces expose `--trust` for one-invocation
project trust. Command-only packs retain their previous dispatch behavior. Values replace whole namespaces in precedence order: user
base < user profile < trusted project base < trusted project profile. No implicit
field-wise merging or project-trust bypass occurs. Pack config does not select a
provider or change child environment authority.

The reserved compatibility namespace `packs.ship` accepts `reviewers` and `checks`;
profiles accept `packs.ship.checks` (reviewers remain base-only, as before).
Existing top-level `reviewers`/`checks` still load through the same validators and
consumers, with a deprecation warning pointing to the full namespace path.
When both forms occur in one declaration, the namespace wins; invalid legacy
values still fail validation. Files need not be rewritten. Ship schema registration
is owned by the compatibility bridge until extraction, not replaceable by a host
pack. The initial R19b slice excluded skills/scripts/train extraction.

R19c source-pack extraction now owns shipping scripts, bundled skills, shared policy,
and instruction/script tests under `packs/ship`. Checked-in legacy skill and policy
paths are generated compatibility outputs (`pnpm ship:sync`), verified without
writing by `pnpm ship:check`. Existing hosts discover those flat outputs, avoiding
double registration. Product Vitest discovery stays product-only; the separate
pack lane gates every PR and replays compatibility skills through a CRLF fixture.
Installed-package activation and R19d train/session extraction remain separate.

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

M7 was the last row of this table. The continuation — R-milestones distilled from a study of six
open harnesses (Codex CLI, pi, DeepSeek Harness, Hermes Agent, OpenClaw, nanobot) — lives in
`docs/ROADMAP.md` and is worked under the same flow and the same exit criterion.

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

---

## 9. Follow-ups

Work that is understood, scoped and deliberately not built — each with the reason it is not a bug
fix. Same standing as AgentLens in §7: recorded so it is a decision rather than a surprise.

| # | Follow-up | Why it is not in the build order | Shape of the fix |
|---|---|---|---|
| ~~F1~~ | ~~**PKCE + loopback login for `openai-chatgpt`**~~ | **Built (2026-08-30).** `startLoopbackLogin`: PKCE S256, a one-shot listener on both loopback stacks, state checked, code exchanged at `/oauth/token`. The device-code flow it replaces is deleted — it could never work. | — |
| ~~F2~~ | ~~**A configurable shell for the `bash` tool**~~ | **Built (2026-08-30).** `bashTool({ shell })` and `--shell`; POSIX keeps `/bin/sh`, Windows prefers Git Bash, then PowerShell, then `cmd.exe`, and the tool description names both the shell and the syntax to write in. | — |

| ~~F3~~ | ~~**A Windows CI job**~~ | **Built (R2 wiring, PR #93; consolidated 2026-09-07, PR #209).** `windows-sandbox-none` runs on every PR and main push over an explicit include list in `vitest.windows.config.ts`, one vitest boot. It proves the no-op sandbox seam and the memory/CLI paths listed there; POSIX process-integration tests stay off Windows by design. | — |

F1, F2 and F3 are built. The table is kept as the record of why each was deferred and what closed
it.
