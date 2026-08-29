# Status

Current milestone: **M5**

| M | Deliverable | Status |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | done (2026-08-29) |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | done (2026-08-29) |
| 2 | OpenAI-compatible adapter, compaction, resume | done (2026-08-29) |
| 2.5 | Experimental `openai-chatgpt` provider: device-code OAuth against a ChatGPT subscription (PLAN §2.9) | built (2026-08-29) — logic tested, not yet validated against the live endpoint |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest, `index.md` injection, index ∪ BM25 search, attempts ledger, pins | done (2026-08-29) |
| 3b | Lore backend: `MemoryBackend` seam + Lore adapter (ingest push, recall union, promote, provenance both ways) | done (2026-08-29) |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | done (2026-08-29) |
| 5 | Dream = scheduled lint over a wiki copy, review/auto, promotion to global | next |
| 6 | Supervisor v2: trajectory reviewer + rubric grader, force_replan | |
| 7 | TUI, hooks, MCP client, subagents, skills — as dogfooding demands | |

## M0 notes

- `HarnessEvent` = envelope (`seq`, `sessionId`, `ts`, stamped by the store) + discriminated `EventPayload`.
- `SessionStore` is append-only JSONL, one file per session; `read` validates every line and fails on seq gaps.
- `memory` and `supervisor` export interfaces only.
- `pnpm demo` writes a session containing the exact loop pattern M4's `loop` detector must catch.

## M1 notes

- `agentrig run "<task>" --headless --json` works end to end; `ask` resolves to deny headless.
  Without `--headless` on a TTY, `ask` prompts on stderr via `AgentConfig.onAsk` (the same seam
  the M7 TUI will use).
- Tools declare `paths()`; `cwdOnly` permission rules confine file tools to the project.
  `--allow write` is cwd-confined; `--allow write:anywhere` lifts it. bash declares no paths and
  cannot be confined — `--allow exec` is all-or-nothing.
- Stop reasons: `refusal` ends the session `done` with a non-fatal error event; a final response
  truncated at `max_tokens` ends it `reason: error` (CLI exit 1); unknown provider stop reasons
  surface verbatim via `raw` in the fatal error message.
- `steer()` takes an optional source (`user` default; the M4 supervisor passes its own); a steer
  still queued when the session ends is recorded as a non-fatal error, never silently dropped.
- Every event — including `file.changed` emitted from inside tools — goes through
  `SessionStore.append` on one promise chain, so `seq` order is emission order and
  `session.events` replays identically to the on-disk log.
- `ToolResult` gained optional `isError`: expected failures (non-zero exit, missing file, bad
  regex) reach the model as error tool_results; throwing is for unexpected failures only.
- Anthropic adapter speaks the streaming REST API directly (no vendor SDK) with an injectable
  `fetchFn`, so tests exercise the full SSE path with no network.
- Budgets are enforced at turn boundaries; `maxUsd` binds only when `pricing` is configured.
- Deferred to their milestones, per build order: hooks, compaction, resume (M2), TUI (M7).

## Exit-criterion debt: dogfooding

PLAN §6's exit criterion ("the harness is used to build the next milestone") is **not yet met**:
M1 and M2 were built without running the harness. Two live smoke attempts against
`gpt-5.6-sol` (2026-08-29, reports on PR #2) got as far as real streaming requests: the first
was blocked by the environment's network allowlist, the second by an exhausted OpenAI credit
balance. Both validated the error path live — well-formed fatal `error` events carrying the
provider's response verbatim, `session.end reason=error`, exit 1, clean log replay — and the
second prompted retry/backoff in the adapters (below). M3 must be built through `agentrig run`
(worker sessions for real subtasks, resume and compaction under real load) once the OpenAI
account has credits.

## M2 notes

- `OpenAICompatibleProvider` speaks Chat Completions streaming (OpenAI + local servers); one
  unified user message fans out to individual `tool` role messages; `apiKey` is optional for
  keyless local servers; same injectable `fetchFn` and truncated-tool-JSON guard as the
  Anthropic adapter. New event type `session.resume` (zod variant + render case + tests).
- Compaction defaults on: `summarizeOlderTurns()` fires past 70% of the provider's context
  window, keeps the task message and the last N messages verbatim (boundary widened so no
  tool_result is orphaned), and summarizes the middle via a direct provider call — that call is
  not metered by the budget. Emits `context.compact`.
- Resume: the loop writes a snapshot (`<id>.snapshot.json`, atomic overwrite) after every
  completed turn and at session end; `run(task, {resume: id})` restores messages/turns/usage/usd
  from it, appends to the same JSONL with contiguous `seq`, and emits `session.resume`. The log
  stays the source of truth — the snapshot is a cache; resuming without one fails loudly.
  CLI: `agentrig sessions resume <id> [task...]` and `run --resume <id>`; `--provider openai`
  with `--base-url` for local servers.
- Hardening from the M2 adversarial review: compaction is raced against abort and gets the
  session signal (a hung or failing summarization call can no longer wedge or kill a session;
  no-progress compaction warns once and stops retrying); snapshots synthesize error
  tool_results for a trailing unanswered `tool_use` so interrupted sessions stay resumable, and
  a resumed run that completed no turn never overwrites the prior snapshot; resume takes an
  advisory `<id>.lock` so concurrent resumes fail loudly instead of corrupting the log's seq
  order (a crashed holder's lock must be deleted by hand — the error names the path); the
  OpenAI adapter sends `max_completion_tokens` against api.openai.com (`max_tokens` for other
  base URLs, `maxTokensParam` to override); when a provider reports no usage the loop warns
  once and compaction falls back to estimates. `maxTurns`/`maxTokens`/`maxUsd` bind across
  resumes; `maxMinutes` is per-run wall clock; resuming a budget-ended session requires
  raising the budget.

## Post-M2 hardening (from live smoke findings)

- All three provider adapters (and the ChatGPT auth/refresh calls) retry transient HTTP failures (429 rate limits, 5xx, network errors) with
  exponential backoff honoring `Retry-After`, capped at 3 retries / 30s, abort-aware; a 429
  that is quota/billing exhaustion fails immediately (retrying can't help). `RetryPolicy` is
  per-provider config.
- Headless `--json` mode mirrors fatal error events to stderr so a human tailing the process
  sees them without parsing the event stream.

## M2.5 notes

- `OpenAIChatGPTProvider` speaks the Responses API against
  `chatgpt.com/backend-api/codex/responses` with self-identifying attribution headers
  (`originator: agentrig`, own User-Agent — see §2.9), authed by the OAuth access token. Whether
  the endpoint accepts a non-first-party originator is the open live question; a 403 there is a
  real answer, not a thing to route around.
  `OpenAIChatGPTAuth` owns the device-code login, an atomic token store (default
  `~/.agentrig/openai-chatgpt-auth.json`, `AGENTRIG_OPENAI_CHATGPT_AUTH` to override), and
  proactive + 401-forced refresh that persists refresh-token rotation. CLI:
  `agentrig login openai-chatgpt` then `run --provider openai-chatgpt --model gpt-5.6-sol`.
- **Not yet validated live.** The endpoint/headers/payload and the device-code and refresh JSON
  field names are read from the Apache-2.0 openai/codex source and RFC-8628-style conventions;
  everything is unit-tested with injected fetch (request mapping, SSE parsing, refresh/rotation,
  expiry, device poll), but the first real `login` + `run` against OpenAI is the live check.
  Expect small field-name fixes on first contact; the provider is experimental by design.
- **Auth reuse for cloud/unattended runs.** Authorize once, then seed every session: run
  `agentrig login openai-chatgpt` on any machine, `agentrig login openai-chatgpt --export` to
  print the bundle, and set it as `AGENTRIG_OPENAI_CHATGPT_TOKEN` in the environment. A fresh
  container with no token file reads that env var (AgentRig's own shape *or* a pasted Codex
  `~/.codex/auth.json`), and within-session refresh still writes to the file. The interactive
  browser approval is inherently human and one-time — the harness cannot and should not perform
  it; the seed makes it a once-per-token step, not once-per-session.
- Hardening from the M2.5 adversarial review: every token response is validated before it may
  overwrite a stored credential (a drifted 200 fails loudly instead of writing `undefined` into
  an unrecoverable loop — the endpoint is expected to drift, so this is the load-bearing check);
  the token file is written via `O_EXCL` under a random temp name, so it can never follow a
  planted symlink or inherit a loosened mode, and the temp is removed if the rename fails; a
  corrupt token file falls through to the env seed with a one-time warning instead of bricking
  the provider; the provider and all auth calls go through `fetchWithRetries`, and a refresh
  failure distinguishes a rejected grant ("re-run login") from a transient outage
  (`TransientAuthError`, credentials still good); quota-vs-rate-limit classification is
  structured rather than substring-matched (a rate limit that merely links to a billing page is
  retried, not hard-failed); `Retry-After` accepts the HTTP-date form; response bodies are
  redacted before they enter an error message, since errors reach the session JSONL; an
  unrecognised `incomplete_details.reason` surfaces as an `error` stop with `raw` rather than a
  clean `end_turn`; a missing `call_id` gets a synthesized id so tool pairing holds; an opaque
  (non-JWT) access token refreshes on age via `lastRefresh`.
- **Reasoning replay.** Responses-API reasoning models emit `reasoning` items that must
  accompany their `function_call` on the following request, and the unified `ContentBlock`
  schema has nowhere to hold them — so the provider caches each response's raw items keyed by
  call id and replays them verbatim (requesting `include: ["reasoning.encrypted_content"]`).
  Without this, turn 2 of any tool-using conversation would 400. The cache is bounded and
  per-provider-instance, so a resumed session in a fresh process replays reconstructed calls
  instead — acceptable for non-reasoning models, and the most likely first live failure to
  watch for with a reasoning model.
- **The device-code login cannot run headless (permanent, verified 2026-08-29).**
  `auth.openai.com/deviceauth/usercode` sits behind a Cloudflare interactive bot challenge
  (`cf-mitigated: challenge`, 403 with an HTML interstitial), so the flow needs a real browser
  and never completes from a cloud container. Sign in on a machine with a browser, then
  `login openai-chatgpt --export` and set the bundle as `AGENTRIG_OPENAI_CHATGPT_TOKEN` in the
  environment's secrets (an existing Codex `~/.codex/auth.json` can be pasted directly). The
  harness now names this condition instead of dumping the interstitial markup.
- **Honest originator was NOT rejected pre-auth (verified).** An unauthenticated probe of
  `chatgpt.com/backend-api/codex/responses` sending `originator: agentrig` returned **401
  Unauthorized, not 403** — it cleared the edge and reached the application layer, refused only
  for missing credentials. This disproves the spike's claim that a non-Codex originator is
  filtered outright. It does **not** yet prove acceptance post-authentication; that remains the
  open question for the first credentialed call.
- Concurrency caveat: one subscription token should have a single refresh owner. Fanning out
  many resumed/parallel worker sessions on one token can race on refresh-token rotation; a
  static env seed sidesteps this only while the access token is still valid (~hours).

## M3 notes

- **Wiki on disk, no database.** `FileMemoryStore` over plain markdown: `index.md` is the
  catalog *and* the reservation ledger, `log.md` the append-only chronology, pages under
  `sources/ entities/ concepts/ analyses/`. Frontmatter is a deliberately tiny hand-rolled
  subset (scalars + inline lists) so the wiki needs no YAML dependency and stays human-diffable;
  a malformed page throws rather than being half-read. Index rows escape `|` and parse on
  unescaped pipes only — a summary containing a pipe used to corrupt the row.
- **Reservation is an O_EXCL page placeholder.** `reserve(slug, claimant, type)` creates the
  page atomically; a second claimant gets `exists` and is appended to `claimedBy` rather than
  overwriting the first. The LLM call happens outside the claim, per PLAN §3.2.
- **Retrieval is additive by construction.** `unionRetrieve` returns index-selected pages ∪ BM25
  top-k, and index picks are never subject to the BM25 `k` cutoff — so recall cannot regress
  below index-only. Hits carry `via: index | bm25 | both`. BM25 searches slug and aliases as well
  as the body, so "auth" finds `auth-module`.
- **Coverage is enforced, not hoped for.** Ingest splits the transcript into character-bounded
  spans (so one huge tool result can't blow the window) and every span must return either facts
  or an explicit `nothingDurable`. A span the model fails to distill throws and names the line
  range — a silent coverage hole is the failure this exists to prevent. `model.delta` events are
  dropped from the transcript as noise; tool calls, results, file changes, errors and steers are kept.
- **Duplicate captures** are settled by prefix comparison against a `capture:prefix` marker in
  the source page: a re-ingest of identical content is skipped, a grown transcript supersedes the
  earlier capture, and existing fact lines are never duplicated on re-ingest.
- **`raw/` is immutable in practice, not just in doctrine.** Attempts are one immutable file each
  (a duplicate id is refused), `addDoc` never overwrites (name collisions get a numeric suffix),
  and `isSessionLog` excludes core's `*.snapshot.json` / `*.lock` working files.
- **Pins store the claim, not a diff**, so re-application survives rewording; `claimSatisfied`
  tolerates one dropped content word. A contradicted pin becomes `conflict` and is surfaced —
  never silently dropped — and a missing anchor becomes `orphaned`.
- **Index injection is bounded.** The catalog rides in the system prompt (`run --memory <dir>`);
  past the cap the tail becomes "…and N more pages; use memory_search", so a large wiki degrades
  to search rather than eating the context window.
- CLI: `agentrig memory init|ls|show|search|ingest|lint`. `lint` currently reports the pin
  re-check and unfilled reservations; the full dream lint is M5. Provider construction was
  extracted to `provider.ts` so `run`, `sessions resume`, and `memory ingest` share it and the
  CLI stays thin.
- Ingest is exercised with a scripted fake `ModelProvider`; as with M1/M2 the model call is one
  seam and the suite stays network-free.

### M3 hardening (from the adversarial review)

The review found three of the milestone's headline guarantees were not actually kept, and two
defects that meant M3 did not run at all. All fixed, each with a regression test:

- **`index.md` was a lost-update race.** `upsertIndex` is a read-modify-write; two concurrent
  ingests deleted each other's catalog rows, leaving pages on disk permanently invisible to
  index-first retrieval — the exact scenario `reserve` exists for. Index mutation is now
  serialized in-process and behind an `index.md.lock` across processes (stale locks are broken
  after 10s). `reserve` also re-adopts a page whose row went missing instead of returning
  `exists` and leaving it orphaned.
- **`memory ingest` could never find a session `run` wrote.** Sessions defaulted to
  `.agentrig/sessions` while ingest reads `raw/sessions` per PLAN §3.1. The default is now
  `.agentrig/raw/sessions`, so the run → ingest flow works out of the box.
- **The memory tools were never registered.** `run --memory` injected an index telling the model
  to call `memory_read`/`memory_search` while the agent only had the six built-ins. They are now
  registered when `--memory` is set, with the read-class ones allowed by tool name (they are
  confined to the wiki root by the store, which a `cwdOnly` rule cannot express).
- **Source-typed facts were counted and written nowhere.** The prompt offers `pageType: "source"`
  and the schema accepts it, but the target loop skipped them while every accounting surface
  reported success. They now land on the session's own page.
- **"Explicitly closed" was not enforced.** `nothingDurable || facts.length === 0` collapsed
  "the model told me the span was empty" into "the model gave me nothing" — so a truncated reply
  read as covered. Now: an explicit `nothingDurable` is coverage; facts are coverage; a summary
  with no facts is coverage; and a reply with none of those throws, naming the span. Summaries
  are recorded before the branch so one can never be discarded.
- **A diverged re-ingest destroyed the source page.** The prefix check only decided skip-vs-not;
  the source body was replaced unconditionally. It now merges unless the capture was provably
  superseded, keeping PLAN §3.2's "unique content is never deleted" true.
- **Pins could not see a reversal, and nothing re-checked them.** The search tokenizer drops
  "not"/"never", so a page rewritten to the opposite claim read as `kept`. `claimSatisfied` now
  compares clause-scoped negation polarity and requires short claims to match in full — biased
  toward a false `conflict` over a false `kept`, since a silent loss is the failure pins exist to
  prevent. `recheckPins` now runs on every regeneration (ingest and `memory_write`), surfacing
  conflicts in the result rather than waiting for someone to run `memory lint`.
- **`raw/` could be overwritten.** `addDoc` had a stat/write TOCTOU that let concurrent calls
  clobber a source; it now creates exclusively and advances the suffix on `EEXIST`. Attempts are
  written temp+rename, and one torn file is reported via `readAttempts().corrupt` instead of
  throwing a raw `SyntaxError` that took down every ingest.
- **`memory_read` escaped the wiki root.** `../` resolved straight out, and the tool declares no
  `paths()` (a wiki-relative path would wrongly satisfy a `cwdOnly` rule), so enabling it granted
  unconfined reads. The store now rejects any path escaping its root.
- **Retrieval: `k` was not a bound.** Index picks were unbounded, so one common word could return
  every page. The index side is now ranked by term overlap and capped at `k`. The honest
  guarantee is therefore *"index-matched pages always outrank BM25-only ones, and the index side
  is ranked rather than arbitrarily truncated"* — not "index picks are never dropped".
- Smaller: `extractJson` scans top-level balanced values and keeps the richest (a `{}` in prose
  used to win, and a nested object could outrank the payload); coverage spans report original
  transcript line numbers; the capture marker is stripped from search text and snippets; hyphenated
  slugs are indexed by their parts (`auth` finds `auth-module`) while queries stay exact;
  frontmatter list items survive commas and unknown keys survive a rewrite; `indexInjection`'s cap
  covers the header and tail; `applyPinChecks` merges instead of replacing; `memory search -k`
  validates its argument; `memory show` reports a non-page instead of dumping a stack trace.

## M3b notes

- `MemoryBackend` is a sink and an *extra* recall source, never the truth and never a
  dependency. With nothing configured there is no backend at all — `loreConfigFromEnv` returns
  null unless both `LORE_API_URL` and `LORE_API_KEY` are set, so the no-infra default stands.
- **A backend can never block or break the wiki.** The backend block is genuinely the *last*
  thing `ingestSession` does — after page writes, after the pin re-check, after `appendLog` — and
  it is wrapped internally in `tolerant()` regardless of what the caller passed, so a raw
  (unwrapped) backend that throws still leaves a fully ingested session. `tolerant()` also
  imposes a timeout (default 15s) so a hanging backend cannot stall ingest, and guards `onError`
  itself so a throwing logger (EPIPE under `| head`) does not become the failure it was
  reporting. The ordering test observes the wiki *from inside* `onIngest` rather than asserting
  after the fact — the earlier version passed even with the call moved to the top.
- **Union, never replacement.** `withBackendRecall` appends backend hits after every local hit
  and drops any that duplicate a page already returned, so enabling a backend can only add. It
  enforces `k` itself, and `LoreBackend.recall` also slices to `k` (Lore's `limit` is advisory).
  Backend page tags (`<pageType>/<slug>`) are normalized to wiki paths before comparing, and
  backend-only hits carry a synthesized `page` so a caller never has to special-case them.
- **Provenance both ways, and it is written down.** A Lore memory carries
  `metadata.agentrig = <project>/<type>/<slug>` plus `agentrig` / `project:` / `session:` /
  `page:` tags; on the wiki side `annotateProvenance()` rewrites the stored fact lines to
  `(session:s1, lore:m0)` from the `BackendAck[]` that `onIngest` returns, so the memory id is
  durable in the page rather than only visible on a later recall. `promote` uses the same
  provenance namespace as ingest so the two do not diverge.
- Lore's contradiction check is **opt-in** (`checkBackendConflicts`) rather than a per-ingest
  round trip; when on, `backendConflicts` is reported alongside the wiki's own pin conflicts. The
  wiki lint runs regardless (the full dream pass is M5).
- `promote` maps a wiki page to one shared-scope Lore memory (private→shared), exposed as
  `agentrig memory promote <path>`. `openBackend()` is try/caught in the CLI so a malformed
  `LORE_API_URL` degrades to no backend instead of crashing `run`. The project name defaults to
  `basename(resolve(process.cwd()))` when `LORE_PROJECT` is unset.
- Lore responses are parsed **per row** with zod: one malformed row is dropped with a report
  rather than failing the whole recall.

## M4 notes

- **Two additive core changes** were needed and nothing else. `SessionControl.record()` lets the
  supervisor append `supervisor.signal` / `supervisor.intervention` through core's *single* append
  chain, so `seq` remains one total order over the agent's events and the observer's — a second
  writer would have raced the chain and corrupted that order. It is deliberately narrow (those two
  payloads only) so an observer cannot forge a `tool.call` or a `session.end`, and it drops records
  after the session ends so `session.end` stays the log's last line. `PlanItem.scope?: string[]`
  gives the `drift` detector something to compare against; nothing carried a declared scope before.
- **Fanning out the event stream needed no change at all.** Core's `EventStream` buffers and
  replays from position 0 for each `[Symbol.asyncIterator]` call, so the CLI and the supervisor
  each get their own cursor over the same events. The observer therefore applies no backpressure
  to the loop: an observer that is slow *asynchronously* delays interventions and nothing else.
  The limit of that guarantee is worth stating plainly — the observer shares one JS thread with
  the agent, so a detector that burns CPU **does** stall the run. `EventStream` decouples
  backpressure, not CPU. Detectors are expected to be cheap; that is what "heuristic, LLM-free"
  buys.
- **The ladder skips rungs it cannot perform rather than parking on them.** One definition
  (`inject_guidance → force_replan → run_reviewer → escalate → abort`) is filtered by declared
  capabilities, so in M4 it collapses to guidance → abort and deepens by itself when M6 attaches a
  reviewer and M7 lands the pre-tool hook. The important case is `escalate`: it is available only
  when an `onEscalate` handler exists, because a headless run has no human and a ladder that
  stopped there would leave a looping agent to burn its whole budget.
- **A signal suppressed by cooldown does not advance the rung.** Otherwise a noisy detector would
  silently climb to `abort` while every intervention was being thrown away — the session would die
  from interventions it never actually received.
- **The supervisor cannot break the session.** Every detector, policy and apply call is wrapped;
  a throw is reported through `onError` and the observer continues. `onError` itself is guarded, so
  a throwing logger does not become the failure it was reporting. Tests drive an exploding
  detector, an exploding policy and an exploding logger and assert the session still finishes
  `done`.
- **`onEscalate` is bounded (60s by default).** It runs inside the event loop, so an unbounded
  wait did not merely delay one intervention — the observer stopped consuming events, never
  reached the `abort` rung, and the looping agent it existed to stop burned its whole budget. The
  natural handler (prompt a human) blocks until someone types, so this bound is the difference
  between a supervisor and a deadlock. Reaching `escalate` with no handler is reported through
  `onError` rather than recorded as an intervention that quietly does nothing, and `supervise()`
  derives the capability from the handler's presence so declaring it without one cannot buy a
  dead rung.
- **`record()` validates before appending.** `Detector` is a public interface and `signal()`'s
  clamping is optional, so a third-party detector can hand back `confidence: 1.4` — or `NaN`,
  which `JSON.stringify` writes as `null`. `serializeEvent` is a bare stringify, so either would
  write a line `SessionStore.read` then refuses forever, breaking `sessions show`, resume and
  `memory ingest` for that session with no repair path because `raw/` is immutable. Invalid
  records are dropped and reported as a non-fatal `error` event instead.
- **Pass counts come from scraped test output**, because no event carries one and two detectors
  (`stall`, `test_regression`) are specified in terms of it. Every pattern is **anchored on
  something only a test runner prints** (`Tests`, `Tests:`, `test result:`, pytest's `=` rule, a
  count at the start of a mocha line, go's `--- PASS:`). The first version scanned for a bare
  `/(\d+)\s+passed/` anywhere and defaulted the missing half to zero, so `rsync: 3 failed to
  transfer` read as a completed run with *zero passes* — `test_regression` scored that as losing
  the whole suite and the ladder escalated to `abort`. A half-match on prose must return `null`,
  never a zero.
- **`test_regression` fires only on a *drop* against the best count seen, in a comparable run.**
  Two things it must not mistake for a regression: a **subset run** (327 → 120 after "run
  everything, then iterate on one package" — the most common agent workflow there is), so a run is
  only compared when its `total` is at least the best total seen; and a **newly written failing
  test** (added failures with no lost passes), so failures alone are never the trigger.
- **`loop` clears its tallies on real progress.** A file changing to content it has not held
  before means the session moved, so the repeat counters reset. Without this, re-reading one spec
  file between edits — textbook agent behaviour, three identical `read_file` inputs — read as a
  loop, and a session writing a new file every turn was aborted at turn 6 with five files of
  genuine progress behind it. "Going in circles" has to mean circles, not repetition. The same
  reset applies to the repeated-error rule: three different assertion failures with edits in
  between are debugging, three identical failures with no edit are a loop.
- **`loop` fingerprints errors before comparing them**: durations, hex ids, pids and temp paths
  differ on every run and would otherwise make one tight loop look like a stream of distinct
  errors. The duration rule is `\b`-anchored so it cannot fire inside an identifier (`p5s` is not
  five seconds), and the hex rule requires a digit so ordinary words like `deadbeef` do not
  collapse into each other. Edit→revert thrash is `file.changed.contentHash` returning to a value
  the path held *earlier* and differing from what it holds now — rewriting the same content is a
  no-op write, not a revert — tallied per file, with both the per-path history and the tracked-path
  set bounded.
- **`stall` treats a turn that reaches for a tool it has not used before as productive**, even if
  it wrote nothing — otherwise reading and exploring would count as spinning. Its test-run branch
  counts only runs that are **still failing** and resets whenever a file changes: an unchanged
  pass count on a *green* suite is the success condition, and re-verifying that a refactor kept
  the suite green is exactly the shape this would otherwise have called a stall.
- `drift` is v1 as specified: a literal path-prefix comparison, no model in the loop. Scope entries
  are exact paths or directory prefixes, not globs, on the grounds that a plan forced to write `**`
  will declare a scope so broad drift can never fire. Both sides are normalized before comparing —
  `\` becomes `/`, `..` is resolved so a path climbing out of the scope is not counted as inside
  it, and an entry that normalizes away (`.`, `""`, `/`, `./`) means **the whole repo**. That last
  case matters: leaving `"."` as a literal segment made the most natural way to declare a repo-wide
  scope turn *every* file into a stray. The LLM-judged, sampled version is M6.
- `force_replan`, `run_grader` and `checkpoint_rollback` are recorded but **not applied** — they
  need the pre-tool hook (M7), a grader (M6) and git checkpoints respectively. The default policy
  will not emit them unless the capability is declared; a hand-written policy that does gets an
  `onError` report rather than silence.
- CLI: `--supervise`, `--supervisor-no-abort`, `--supervisor-soft <fraction>`. The soft budget
  thresholds are derived from the same `--max-*` flags core enforces as hard limits, so the two can
  never disagree. Flag validation now runs **before** the provider is built: a typo'd budget flag
  should say so rather than be masked by a missing-credential error from a provider the run was
  never going to reach. The `finally` join on the observer is bounded (2s, then `detach()`) so an
  early exit from the render loop — EPIPE under `| head` — cannot hold the process for the
  session's whole remaining lifetime.
- **Caveat: the supervisor reacts one event behind.** It observes asynchronously, so between the
  event that triggers a signal and the steer landing, the agent may take another action. `steer` is
  queued to the next turn boundary anyway (the only coherent injection point), so this is inherent
  to an out-of-band observer rather than a fixable lag.
- **Caveat: `drift` cannot fire today in practice.** Nothing emits `plan.updated` yet — there is no
  planning tool until M7 — so the detector is correct and tested but dormant until something
  declares a plan.

## Decided

- Lore is an optional `MemoryBackend` behind the seam in PLAN.md §3.8; the wiki stays the source
  of truth and the default stays no-infra (milestone 3b).
- AgentLens is a future sink for the event stream (observability), not a memory dependency.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Dogfood repo after AgentRig itself
