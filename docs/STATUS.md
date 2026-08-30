# Status

Current milestone: **all milestones complete** — M0 through M7. M2.5's live validation, the one
thing the table carried as unproven, is done: the provider authenticates and reaches the model.

| M | Deliverable | Status |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | done (2026-08-29) |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | done (2026-08-29) |
| 2 | OpenAI-compatible adapter, compaction, resume | done (2026-08-29) |
| 2.5 | Experimental `openai-chatgpt` provider: device-code OAuth against a ChatGPT subscription (PLAN §2.9) | validated live (2026-08-30) — authenticates and reaches the model; credential must be seeded from Codex, see notes |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest, `index.md` injection, index ∪ BM25 search, attempts ledger, pins | done (2026-08-29) |
| 3b | Lore backend: `MemoryBackend` seam + Lore adapter (ingest push, recall union, promote, provenance both ways) | done (2026-08-29) |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | done (2026-08-29) |
| 5 | Dream = scheduled lint over a wiki copy, review/auto, promotion to global | done (2026-08-29) |
| 6 | Supervisor v2: trajectory reviewer + rubric grader, force_replan | done (2026-08-29) |
| 7 | TUI, hooks, MCP client, subagents, skills — as dogfooding demands | done (2026-08-30) |

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
- **Validated live on 2026-08-30 (Windows, Node, seeded from a Codex credential).** Two answers
  the unit tests could never give:
  - **The honest originator is accepted post-authentication.** `originator: agentrig` with a real
    token reached the application layer and was answered on its merits — no 403, no edge block.
    The spike's worry that a non-Codex originator is filtered is now disproved on both sides of
    authentication.
  - **The backend rejects `max_output_tokens`**: `HTTP 400 {"detail":"Unsupported parameter:
    max_output_tokens"}` on the first authenticated request, before a single token was generated.
    Codex does not send it either. The provider no longer sends it, so `ModelRequest.maxTokens`
    cannot bind one response here — the session budget still meters what was spent, and the CLI
    warns when `--max-tokens-per-turn` is typed against this provider rather than accepting a
    number it will not send.
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
- **The device-code login cannot run from ANY Node process (corrected 2026-08-30).**
  `auth.openai.com/deviceauth/usercode` sits behind a Cloudflare interactive bot challenge
  (`cf-mitigated: challenge`, 403 with an HTML interstitial). The earlier note said to "sign in on
  a machine with a browser" — that is wrong, and a desktop attempt produced the identical 403:
  the challenge targets the HTTP *client*, not the network location, and `fetch` is not a browser
  wherever it runs. `agentrig login openai-chatgpt` is therefore unusable as written.
  **How to get a credential today:** take Codex's. Its login is a PKCE + loopback flow, so the
  challenged request is made by the browser. `~/.codex/auth.json` is accepted verbatim, either
  copied to `~/.agentrig/openai-chatgpt-auth.json` or set as `AGENTRIG_OPENAI_CHATGPT_TOKEN`.
  **The real fix is a PKCE + loopback login of our own** (browser to `auth.openai.com`, redirect
  caught on a local port), which is the only flow that can work; the device-code path should be
  replaced by it rather than kept.
- **The token file reader accepts both shapes.** It used to parse only AgentRig's own camelCase
  bundle, so the obvious move — copying `~/.codex/auth.json` into place — failed with a "corrupt
  file" error that named neither the cause nor the fix, while the env-var path accepted exactly
  that shape. Both now go through `tokensFromEnvValue`.
- **Honest originator was NOT rejected pre-auth (verified 2026-08-29), and is accepted
  post-auth (verified 2026-08-30).** An unauthenticated probe returned **401, not 403** — it
  cleared the edge and was refused only for missing credentials. The first credentialed call then
  got a **400 about a request parameter**, which is an application-layer answer: the request was
  authenticated and read. The question this row was carrying is closed.
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

## M5 notes

- **The dream actually edits the wiki it hands back.** `applyConsolidation` removes lines, marks
  superseded claims, annotates relative dates, and merges pages. The first cut of this milestone
  did none of it: it reported merges and removals and handed back a directory identical to the
  input, and under `--auto` told the user the corrections were live. PLAN §3.7's "review the
  artifact, not the plan" only means something if the artifact differs from the input. The report
  is now built from what was **applied**, never from what the model proposed — a removal whose
  line could not be matched is reported as unmatched rather than as done.
- Apply is conservative in one direction: **losing a true fact is worse than keeping a redundant
  one.** Merges append with a `<!-- merged from … -->` marker rather than interleaving (a wrong
  ordering that keeps every fact is recoverable; a wrong interleaving is not), removals need a
  near-exact line match, superseded claims are annotated rather than deleted (a replaced claim is
  still evidence of what was believed), and relative dates are annotated with the dream's date
  rather than rewritten — rewriting would guess at what "yesterday" meant.
- **The input is never touched, by construction rather than by discipline.** The dream is only
  ever handed a *copy* (`copyWiki`), and `fingerprint()` — a content hash of every file, path
  sorted — lets a test prove the original came out byte-identical. A dream that mutated its input
  would be unreviewable: the thing you are reviewing would already have happened. Review is the
  default mode for the same reason; `--auto` is opt-in.
- **That invariant had a hole, and "by construction" is what closed it.** `copyWiki` copied
  symlinks as symlinks, and `appendLog` was the one writer not using tmp+rename — so a symlinked
  `log.md` carried the dream's log line straight back into the original wiki. `copyWiki` now
  dereferences (which also makes the copy self-contained, so it cannot track the input mid-dream)
  and `appendLog` writes atomically like every other writer. A symlinked wiki *root* used to fail
  the whole command with an opaque `ERR_FS_CP_NON_DIR_TO_DIR`; it is resolved first now.
- **Most of the dream costs nothing.** The structural half (orphans, missing pages, index drift,
  stale file refs, relative dates, unsourced facts, unfilled placeholders) is derivable from the
  wiki's own text, so it runs with no model call. Only `consolidate` — contradictions, superseded
  claims, merges, removals — needs judgment and therefore tokens. That split is what makes
  `agentrig memory lint` free enough to run on every session end, and it is why `--structural-only`
  does not require a credential at all.
- **`memory lint` is now the real thing.** PLAN §5 defines it as "a dry-run dream report, no output
  store", so it runs the actual dream in structural-only mode and deletes the copy. It used to be
  a stub that only re-checked pins.
- **Promotion is a structural gate, not a prompt instruction.** PLAN says twice that nothing
  derived from a single session may be promoted, so the rule is enforced by counting *distinct*
  `session:` refs from frontmatter and each fact line's parsed `(…)` provenance group — and only
  from that group. Free-scanning the line text for `session:` meant a CI log URL
  (`https://ci/logs/session:9f3a1b`) or a sentence mentioning another session corroborated the
  page with itself, so a single-session page promoted itself to global. The model writes the page
  body, so anything derived from the body's free text is something the model can talk its way
  past — the gate has to read only the parsed provenance. One session cited five times still
  counts as one. The floor cannot be lowered below two even by a
  caller passing `minSessions: 1`. A low-confidence page is held back even with enough sessions.
  The reasoning: one session's conclusion may be true only of that branch, that machine, that
  afternoon; corroboration across two independent sessions is the cheapest proxy for "this
  generalizes", and it is the difference between a global wiki worth consulting and one that
  accumulates noise.
- **Model findings are filtered against reality.** A consolidation naming a page the wiki does not
  have would send the apply step at a file that does not exist, so `dropUnknownPages` discards it;
  a "merge" of fewer than two pages is likewise dropped. The report has to be actionable.
- **A failed consolidation costs the consolidation, not the dream.** `extractJson` *throws* on a
  response with no JSON in it, so it is guarded separately from the schema check — a model that
  answers in prose leaves the structural findings intact and sets `consolidationError`.
- **`--auto` keeps the previous wiki beside the new one** as `wiki.before-dream-<stamp>` rather
  than deleting it. A dream is a bulk LLM rewrite of the agent's memory; undo has to be a directory
  rename, not a restore from a report. It refuses to overwrite an existing backup, refuses to apply
  a wiki onto itself, and restores the original if the second rename fails. It copies-then-swaps
  rather than renaming twice because the dream's output normally lives in the OS temp dir, which is
  often a different filesystem — `rename()` cannot cross one.
- Each phase is a separately exported function, per PLAN §3.7's "each its own prompt so they can be
  tested independently" — a test drives one phase with a scripted provider without standing up a
  whole dream. `orient` and `prune`/`rebuildIndex` turned out to need no model at all.
- **The prompt is bounded on both axes.** Page text is capped (24k chars, truncated at a page
  boundary) and so are signals — those come from the attempts ledger, which grows for the life of
  the project, and 400 attempts with long lessons built a 212k-char prompt against that 24k page
  budget. Signals are now ranked best-corroborated-first and capped by count and characters.
- **`--since` and `.last-dream` now affect what the dream considers.** They previously reached
  only a log line: attempts were read unfiltered and uncapped, so the marker changed nothing.
  `--since` is validated as a positive integer — `Number("abc")` is `NaN` and `slice(0, NaN)`
  silently yielded nothing, so a typo turned the dream into a quiet no-op.
- **`rebuildIndex` preserves the reservation ledger.** Stamping every row `active` destroyed it:
  the `unfilled` check could never fire again after one dream, and `index.md` — injected into
  every system prompt — began advertising placeholders as real pages whose summary read
  "Reserved by session:s1; content pending ingest."
- **`applyDream` names the directory your wiki is in when a restore fails.** The restore error
  used to be swallowed and the *apply* error rethrown, so a user whose wiki no longer existed at
  `wiki/` was told "could not move staged into place". Nothing else would have told them.
- **Caveat: `consolidate` still sees a bounded slice of the wiki.** On a large wiki the later
  pages are not considered for contradictions in a given run. Chunking across several calls is
  the obvious fix and is not done here.
- **Caveat: the four phases are one model call, not four.** PLAN says each phase gets its own
  prompt; only `consolidate` currently needs one, so that is the only prompt that exists. The
  others are exported and testable but model-free, which is a simplification of the spec rather
  than a full implementation of it.
- **Caveat: nothing schedules the dream yet.** `agentrig dream` is the manual trigger; the
  `session_end` hook and cron triggers PLAN §3.7 names need the hooks surface, which is M7.
- **Caveat: promotion proposals are reported, never performed.** Even with `--auto`, a promotion is
  listed and nothing is written to the global wiki. `--global <dir>` now attaches one so the
  section can at least render — previously no caller ever set `globalWiki`, so the proposals could
  never appear at all and "promotion to global" looked implemented when nothing could reach it.
  Actually writing across scopes is still deliberately left until there is a global wiki worth
  writing into.
- Structural lint hygiene, all from the review: fenced code blocks and inline spans are stripped
  before matching, so a recorded `git log --since="2 days ago" -- src/nope.ts` is a transcript
  rather than two defects; the file-reference check matches any backticked path with an extension
  instead of a four-prefix allowlist that missed `lib/`, `README.md` and `apps/`; the containment
  guard compares on a path boundary, so `../wikix/absent.ts` no longer escapes a `…/wiki` root;
  and an orphan is no longer counted a second time as "unlisted", which inflated the printed
  finding count and the exit code.
- A failed dream disposes its temp copy. `memory lint` runs on every session end, so leaking a
  full wiki copy per failure — one malformed `pins.json` is enough — would quietly fill the disk.

## M6 notes

- **`update_plan` had to exist first.** Two supervisor pieces were specified against
  `plan.updated` and neither could work, because nothing in the harness ever emitted one: `drift`
  (§4.1) compares `file.changed` against the plan's declared `scope`, and `force_replan` (§4.2)
  requires a fresh plan before more tool calls. Both shipped dormant in M4. Adding the tool
  activates both — M4's drift detector is live for the first time.
- **`force_replan` is a real gate, not a message.** `SessionControl.requirePlan(reason)` makes the
  loop refuse every tool except `update_plan`, with the reason passed through so the model is told
  *why* and what to do rather than just failing. It clears the moment a plan lands — including one
  emitted in the same turn — so a cooperative agent loses one tool call, not a turn. This is
  exactly why the rung sits above `inject_guidance` on the ladder: guidance can be ignored, a gate
  cannot.
- **A gate can never be permanent, and is never raised where it cannot be satisfied.** Both halves
  were needed, and the first cut had neither. `update_plan` declares `read` and touches no path,
  and the default read rule is `cwdOnly` — which `RulePolicy` skips when a call declares no paths
  — so under the harness's *own* defaults it fell through to `ask` and headless denied it: a gate
  nothing could ever clear. `defaultRules` now allows it by name. Separately, `supervise()`
  asserted the `forceReplan` capability unconditionally on the grounds that the gate "needs no
  collaborator"; it does — the session's tool list must contain `update_plan`. It is now derived
  from `control.canRequirePlan()`, and a caller asking for the rung on a session that cannot serve
  it gets an `onError` report. As a belt-and-braces third measure the gate releases itself after
  `MAX_REPLAN_REFUSALS` (2) with an `error` event saying so, and immediately when the session has
  no plan tool at all. Without these, `agentrig run --headless --supervise --supervisor-no-abort`
  was a live deadlock: 34 of 40 turns refused by a gate nothing could clear, ending on `budget`.
  A supervisor rung that can wedge the loop is strictly worse than the loop it was catching.
- **The reviewer proposes several directions, not one.** A supervisor that hands back a single
  instruction has replaced the agent's judgement with its own on the strength of one sample.
  Candidates keep the decision where the context is, and make the guidance falsifiable — an agent
  can look at three options and recognise that none of them fit. The prompt is also explicit that
  re-suggesting something the attempts ledger already records as failed is the least useful
  possible answer.
- **The reviewer reads the attempts ledger, which is the piece AVO lacked.** Reviewing a
  trajectory alone means re-deriving what was already tried; the ledger says it outright.
- **The grader fails closed.** An unparseable grader response returns `pass: false` with the parse
  failure as the gap. Defaulting to pass would mean a broken grader silently certifies everything,
  which is strictly worse than having no grader at all. The reviewer, by contrast, degrades to
  empty guidance — a reviewer that says nothing costs a rung; a grader that says "yes" costs the
  whole point of grading.
- **The grader is told to grade artifacts, not narration.** "If the trajectory claims something
  the files do not show, that is a gap, not a pass" is in the system prompt, because the failure
  mode of self-assessment is reading your own output charitably.
- **`run_reviewer` became a real `Intervention` variant** rather than the `run_grader`
  placeholder M4 used for that rung. Additive to the discriminated union, with a zod round-trip
  test and a `renderEvent` case, per the repo rule. `renderEvent` now prints an intervention's
  payload instead of `JSON.stringify`-ing it at the reader.
- **Capabilities are derived from what was actually supplied**, applied after any caller-declared
  ones — the M4 review's lesson about `escalate`. Declaring a rung whose machinery is absent buys
  an intervention that silently does nothing; reaching one now reports through `onError`.
  `forceReplan` defaults on because core's gate needs no collaborator.
- Both LLM rungs are bounded by the same timeout mechanism as `escalate` (90s default): they run
  inside the observer's event loop, and an unbounded one would stop it consuming events — the
  M4 review's critical finding, which applies verbatim to any blocking rung.
- CLI: `--supervisor-review` opts into the LLM-backed rungs. They cost tokens, so the default
  stays the free M4 ladder — detectors and guidance — rather than nothing.
- **Caveat: the reviewer and grader share the session's provider and model.** A cheaper or
  differently-aligned reviewer model is the obvious next step and is not wired.
- **Caveat: `artifacts` is caller-supplied.** The supervisor does not infer which files to grade
  from `file.changed`; the CLI passes none today, so `run_grader` grades the trajectory alone
  unless a caller supplies them through the SDK. The CLI also supplies no rubric, so the rung
  stays unreachable from `agentrig run` — reachable from the SDK, and honest about it, rather than
  advertised and dead.
- **Caveat: the reviewer sees the last 400 events condensed to 120**, not "the whole trajectory"
  as PLAN §4.3 words it. The bound is what keeps a stuck session's trajectory from growing the
  prompt without limit; the tail is kept because what the agent just did matters more than how it
  opened.
- **Caveat: a replan gate does not survive `--resume`.** It lives in session state, so resuming
  silently drops a pending requirement.
- **Caveat: `checkpoint_rollback` is still the one unimplemented rung.** It needs git checkpoints,
  which nothing creates yet, and the default policy never emits it.

## M7 notes — hooks (the first row)

M7 is the one milestone PLAN deliberately leaves unordered ("in whatever order dogfooding
demands"), so it ships as several PRs rather than one. **Hooks went first because three earlier
milestones left caveats explicitly waiting on them**: M3's session-end ingest, M5's dream trigger,
and M3b's Lore auto-retrieval. Two of those three are now closed.

- **Seven points, wired where the loop can actually act on them**: `user_prompt`, `pre_model`,
  `post_model`, `pre_tool`, `post_tool`, `pre_compact`, `session_end`.
- **Not every action means something at every point**, so each point declares which it accepts and
  anything else is reported and ignored rather than silently dropped. `session_end` accepts only
  `continue` — the session is already over, so a denial there would be a lie.
- **A hook cannot break the session.** Every handler is wrapped; a throw becomes a non-fatal
  `error` event and is treated as `continue`. An extension point that can kill the thing it
  extends is worse than no extension point.
- **A hook influences the session through its return value or not at all.** Each handler gets a
  *copy* of everything mutable it can see. Without this the whole validation story was theatre:
  `ctx.request.messages` **was** the live message array, so a handler returning `continue` — no
  patch, nothing to validate — could push messages the model then saw with zero events in the log,
  and a `pre_compact` hook, at a point that accepts no `modify` at all, could empty the history and
  send the next request with `messages: []`. Replaying the JSONL would have reconstructed a
  conversation that never happened.
- **A hook cannot hang the session — including after the work is done.** Each handler is raced
  against a timeout (30s default, per-hook override), *and* each point has one wall-clock budget
  for the whole chain. Per-hook overrides alone were not enough: ingest (10 min) and dream (15
  min) run sequentially at `session_end`, so a wedged network call in either could hold
  `session.done` for 25 minutes with Ctrl-C unable to shorten it. The timeout now also aborts a
  controller the handler can observe, and the runner races the session's abort signal — a race
  that merely abandons a promise leaves the work running.
- **A `modify` patch is validated before it is applied.** A `pre_tool` patch is re-parsed against
  the tool's *own* zod schema, and a patch that fails is reported with the original input used
  instead. A hook is third-party code; its patch is a proposal, not an instruction.
- **`pre_tool` sees the parsed input**, not raw JSON, so a hook reasons about typed data. It runs
  before the permission check, so a hook denial and a permission denial produce the same
  `tool.denied` event.
- **`post_tool` can rewrite what the *model* sees without rewriting the log** — and that
  divergence is itself recorded. The `tool.result` event keeps what the tool returned, and a new
  `tool.result.patched` event records that a hook changed what the model consumed. Without it the
  asymmetry ran the wrong way: a hook could inject text into the tool result the model read that
  appeared in neither the log nor anything the supervisor sees, steering the model unobserved.
  "A hook shapes the conversation, it cannot rewrite history" was true but understated — it could
  write *future* history invisibly.
- **A hook nudge is attributed to the hook.** `post_model` injects were logged as
  `steer source: "user"`, and the supervisor's reviewer grades trajectories off those events — so
  a hook nudge was being scored as a human correction. `steer.source` gains `"hook"` (added to the
  enum, not repurposed).
- **Wrong-shaped `modify` patches are reported at every point**, not just `pre_tool`. Three
  mutually incompatible patch shapes hide behind one `patch: unknown` — a bare string
  (`user_prompt`, `post_tool`, last-string-wins), `{system: string}` (`pre_model`), and a shallow
  object merged into the tool input (`pre_tool`). A plugin author with the wrong shape used to get
  silence at three of the four.
- **`HookContext.result` carries `display` as well as `output`.** It was typed
  `{ok, output: string}`, but six of the eight builtins return a non-string `output` (bash returns
  `{exitCode, stdout, stderr}`); a redaction hook written against the declared type crashed on
  `.replace` and was reported as a generic hook failure — the worst outcome for a redaction hook.
  Worse, `output` was not even the string a patch replaces. Now `{ok, display, output: unknown}`.
- **The first `deny` wins and stops the chain.** Asking the remaining hooks to weigh in on
  something already refused is meaningless. `modify` and `inject` accumulate, so two hooks can
  each contribute.
- **`session_end` runs before `session.end` is written**, so a hook can still append to the log —
  which is exactly what ingest needs. `session.end` remains the last line.
- **Both memory hooks are advisory.** `ingestOnSessionEnd` and `dreamOnSessionEnd` report through
  `onError` and return `continue` regardless. A session that finished its work has finished it;
  a failed ingest must not change that.
- **A session id is validated where it is created, because it becomes a filename.** `--resume
  <id>` puts a user-controlled string there and nothing checked it, so
  `--resume '../../../home/user/notes' --ingest-on-end` made the ingest hook read a `.jsonl`
  anywhere on disk, send it to the model, and distil it into the agent's *persistent* memory —
  exfiltration and memory poisoning at once, durable in a wiki every future session reads through
  `index.md` injection. `SessionStore` now rejects anything but `[A-Za-z0-9_-]{1,128}` at
  `create()` and in every path builder, and the ingest hook re-checks containment itself rather
  than trusting a caller upstream to have done the right thing.
- **The dream trigger stamps the LIVE wiki, not just the copy.** The stamp answers "when was a
  dream last run", not "last applied" — writing it only into the output copy meant review mode
  never advanced it, so once the threshold was crossed it stayed crossed: `--dream-on-end` ran a
  full consolidate-phase dream on **every** session end forever, leaking a wiki copy to `/tmp`
  each time and making both cadence flags inert. A never-dreamt wiki is also no longer treated as
  instantly overdue, and a clean review-mode dream disposes its copy instead of keeping one
  nobody asked for. `--dream-structural-only` makes the unattended trigger free.
- **The dream trigger reports, it does not apply.** PLAN §1.5 makes review the default, and an
  automatic dream that applied itself would be the least reviewable thing in the system. `auto`
  exists but is off.
- CLI: `--ingest-on-end`, `--dream-on-end`, `--dream-every-sessions`, `--dream-every-hours`. Both
  are opt-in: ingest costs tokens, and a harness that silently spends them on every exit would be
  the wrong default.
- **Caveat: `pre_model`'s `modify` only patches the system prompt.** Patching messages or tools
  wholesale needs a validated patch shape that does not exist yet, and an unvalidated one is the
  M6 lesson repeated.
- **Caveat: a `pre_compact` veto is permanent for the session.** Re-asking every turn would put a
  hook on a hot path forever; a hook that said no once means no.
- **Caveat: `session_end` hooks still run sequentially.** They cannot deny, so running them
  concurrently would be sound and faster; the group budget bounds the damage in the meantime.
- **Caveat: hooks are constructed in code, not configured.** PLAN §5's `agentrig.config.ts` would
  let a project register hooks declaratively; the CLI wires the two memory hooks behind flags and
  everything else is SDK-only.
- **Still open in M7**: the Ink TUI, the MCP client, subagents, and skills. Lore's auto-retrieval
  (M3b's caveat) now has a `user_prompt` point to attach to but is not wired.

## M7 notes — the TUI (second row)

- **`agentrig` is an `isDefault` subcommand, not options on the root.** Options declared on the
  root `program` are consumed by Commander *wherever they appear in argv*, including after a
  subcommand name — so putting the TUI's flags there silently swallowed `--root`, `--model`,
  `--max-turns` and the rest from every shipped subcommand, which then fell back to its default
  with no error. `agentrig sessions ls --root foo` wrote to the wrong directory and said nothing.
  A default subcommand keeps the TUI's options on the TUI, and preserves Commander's
  unknown-command error so a typo is rejected instead of dropping the user into an interactive
  agent with their intended command discarded.
- **One `buildAgent()` assembles the agent for both entry points.** `run` and the TUI each built
  their own, and the copies had already diverged in seven ways inside the commit that created
  them — different system prompts, no flag validation on the TUI side, no `--allow`/`--deny`, and
  no `session_end` hooks at all, so an interactive session could read the wiki but never write to
  it. That is precisely what CLAUDE.md's "keep the CLI thin" rule exists to prevent, and it was a
  self-inflicted violation.
- **The TUI is layout; a headless `TuiController` is everything else.** A terminal UI is close to
  untestable, so every decision — what a line says, when a permission prompt appears, what a slash
  command does — lives in a class a test drives without a screen. `app.tsx` has no logic in it,
  which is why it needs no test and why the 27 tests here are worth something.
- **Slash-command parsing is a pure function** with a test asserting that *every* command
  `/help` advertises actually parses. A help list that drifts from the parser is the classic way
  a TUI lies to its user.
- **A typo is reported, not sent to the model.** Someone who typed `/memroy` meant to run a
  command; spending a turn on it as a prompt is the least useful possible response. Unknown
  commands print the help so the answer is always in reach.
- **The permission prompt is a promise bridged to UI state.** `controller.ask` is the agent's
  `onAsk`; it parks a resolver, the view renders it, and a keypress resolves it. While a prompt is
  up it takes the keyboard entirely. Requests **queue** rather than replacing each other: a single
  slot silently overwrote the first resolver when two overlapped, leaving its promise unsettled
  and the loop wedged. Core runs tool calls sequentially today so that was latent, but parallel
  execution is an obvious next change and a queue costs nothing now. Nothing is ever dropped
  unsettled — shutdown and abort resolve every outstanding request as a denial.
- **ctrl-C had to be taken back from Ink.** With `exitOnCtrlC` on (the default) Ink unmounts on
  ctrl-C *and refuses to dispatch it to `useInput`*, so the abort handler in the view was dead
  code: the UI vanished while the agent kept running, still executing bash, now invisibly. The TUI
  now renders with `exitOnCtrlC: false` and installs the same `SIGINT → abort` handler `run` does.
- **`/quit` stops the turn before exiting**, for the same reason.
- **Scrollback is `<Static>`.** As live `<Text>` the render cost grew with the buffer — 800 lines
  took 5s at a 500-line cap versus 0.5s at 50 — because Ink repaints the whole frame on every
  print, which also destroys terminal scrollback. `Static` writes each line once above the live
  frame, so the cap could go from 500 to 5000.
- **`/supervisor` says no supervisor is attached** rather than "nothing raised". The TUI attaches
  none, and "nothing raised" reads as *all clear* when the truth is *nothing is watching*.
- **`/abort` answers a pending prompt as well as aborting.** Without that the loop would sit
  waiting for an answer nobody is going to give, and the session would never end.
- **The line buffer is bounded** (500 by default). An unattended terminal running a long session
  must not grow without limit.
- `/memory` and `/dream` are **injected**, not imported, so the controller stays free of stores
  and a test can drive them without a wiki. When they are not wired the TUI says so rather than
  failing silently.
- **Caveat: the input line is a minimal reader** — printable characters, backspace, enter. No
  history, no cursor movement. A paste arrives as one multi-character chunk, which used to land
  embedded newlines in the buffer literally and corrupt the line; it now submits at the first
  newline and keeps the remainder, which is correct rather than pleasant.
- **Caveat: `model.delta` is dropped rather than streamed.** Rendering per-token deltas as lines
  would drown everything else; showing them as a live-updating block is the obvious improvement
  and is not done.
- **Caveat: the TUI does not attach the supervisor.** `/supervisor` shows signals from the event
  stream, so it stays empty unless something else attached one.
- **Caveat: no test renders the React tree.** `ink-testing-library` is installed but unused — the
  controller split means there is nothing in the view worth asserting on, and a snapshot test of
  terminal output would break on every cosmetic change.

## M7 notes — the MCP client (third row)

- **Written against the wire format, not the SDK.** A client needs three request shapes —
  `initialize`, `tools/list`, `tools/call` — over newline-delimited JSON-RPC. The official SDK
  would pull a large surface for that, and the adapter is the interesting part anyway.
- **An MCP tool's permission class is `exec`, always.** The harness cannot know what a
  third-party tool does: a server's `search` may read a database or shell out. `read` would be a
  guess that fails open, and the permission system's whole value is that the dangerous default is
  the safe one. It also declares no `paths()`, so it can never satisfy a `cwdOnly` rule — there is
  no honest way to say which files a remote tool will touch.
- **Tool names are namespaced *and sanitised*.** Both halves are user- or server-controlled and go
  straight into the provider payload, which requires `^[a-zA-Z0-9_-]{1,64}$`. A server named
  `my server` in a config file, a dotted tool name (common in real servers), or a long name from
  an enterprise server all produced a name the provider rejects — and the rejection is a 400 on
  *every* model request, so one bad entry killed the whole session rather than costing only its
  own tools, falsifying the claim that a broken server is contained. Disallowed characters are
  mapped, over-long names truncated with a hash of the original, and the hash is applied whenever
  the composition is not reversible — which also closes the `__`-delimiter collision where
  server `a__b`/tool `c` and server `a`/tool `b__c` composed to one name.
- **A server's schema is normalised before it is advertised.** A server declaring
  `{"type":"string"}` is both rejected by the provider and, if accepted, tells the model to send a
  string that `inputSchema`'s zod check then refuses forever — the two sides disagreeing by
  construction. Non-object schemas fall back to an empty object schema, and `$schema` is stripped.
- **`Tool.jsonSchema` was added to core** (additive) so an MCP tool advertises the *server's* own
  JSON Schema. Converting it to zod and back would degrade it to "an object", losing every field
  description the server wrote — which is exactly what the model needs to call the tool correctly.
  `inputSchema` still governs validation, so a permissive zod schema plus the server's real schema
  is honest on both sides rather than a lossy round trip.
- **A server is third-party code, so the M7a hook lessons apply unchanged**: every request is
  timeout-bounded, a non-conforming reply is rejected rather than trusted, a dead child rejects
  everything outstanding rather than leaving requests pending forever, and non-JSON on stdout is
  reported once rather than crashing the reader. `tools/list` pagination is bounded, because a
  server returning a cursor forever would loop.
- **`close()` reaps the process *group*.** Real MCP servers are commonly wrappers (`npx`, `uvx`,
  a shell shim) that spawn the actual server, so signalling one pid orphaned the grandchild — the
  common case, not the exotic one. The child is spawned `detached` and killed by group, as the
  bash tool does. The teardown sleep is also no longer `unref`'d: an unref'd timer let Node exit
  before it fired, so `close()` never resolved when the event loop was otherwise quiescent — which
  is exactly the teardown case, meaning the SIGKILL escalation was skipped and any later server in
  the list was never closed at all.
- **Config accepts `mcpServers` and `servers`.** Claude Code and Cursor use the former, VS Code
  the latter; accepting only one — with a default of `{}` on top — meant pointing the flag at a
  working config produced a silently tool-less session. Neither key present is now a hard error.
- **The environment is not inherited wholesale.** A user pointing at a third-party binary should
  not hand it every secret in their shell, so only `PATH` plus explicitly configured vars are
  passed.
- **A server that fails to start costs its own tools and nothing else** — one broken entry in a
  config file must not stop the agent from running, the same way a failed hook or backend does not.
- Config is `{"servers": {"<name>": {"command", "args", "env"}}}` — the shape Claude Code and
  Cursor use, so an existing file works unchanged. `--mcp-config <path>`.
- **Caveat: stdio transport only.** HTTP/SSE servers are not supported.
- **Caveat: only `tools/*` is implemented.** MCP resources and prompts are not, and neither is
  the server-initiated side of the protocol (sampling, roots).
- **Caveat: servers are started per session**, so a long-lived server is respawned each run.
- One real-process test covers group reaping, because it cannot be faked. Note the trap it
  documents: `kill(pid, 0)` succeeds on a *zombie*, so checking existence rather than liveness
  reports a false failure — the test polls process state instead.

## M7 notes — subagents and skills (the last two rows)

### Subagents

- **`subagent.spawn` / `subagent.end` had been in the schema since M0 with nothing emitting one** —
  the same dormant contract `plan.updated` was before M6. `subagent.end` gains an optional
  `reason`, because knowing *how* a child finished is the useful part in a log.
- **The point is context isolation, not parallelism.** A search that would fill the parent's
  window with fifty file contents happens in a session of its own and the parent receives only the
  answer. So the child's events go to the child's log; forwarding them would defeat the entire
  reason to spawn one. The parent's log records that a child ran and how it ended — enough to
  trace, not enough to drown.
- **Depth-limited, and the tool threads `depth` itself.** Unbounded recursion here is a fork bomb
  with a token budget attached. Default depth 1: a subagent cannot spawn its own. The child's
  subagent tool is built by the tool at `depth + 1`, and any subagent tool the caller's
  `childConfig()` supplies is dropped — the first version left `depth` for the caller to thread,
  which nothing did, so `maxDepth` could never fire (3601 sessions in 5s with `maxDepth: 1`).
- **A child's budget is stated, never inherited.** A child is a separate session with a separate
  meter, so a parent's `maxTokens`/`maxUsd`/`maxMinutes` cannot bind it: spreading the parent's
  budget gives *every* child the parent's whole allowance, and omitting it gives every child none.
  `subagentTool` takes `childBudget` explicitly and the CLI fills it from the parent's flags.
- **Descendants are pooled per parent session** — `maxChildren` (default 8), `maxChildTokens` and
  `maxChildUsd`. Without this a parent could finish `done` inside a 10-token cap having spent
  thousands of dollars through its children. Three details that a first version got wrong:
  - the pool is threaded down the tree (`ancestorPools`), so a grandchild is charged to *every*
    ancestor. Held per level, `maxChildren` bounded a level rather than a tree — total children
    was `maxChildren ** maxDepth` — and everything below the first level was invisible.
  - a child's cap is **reserved when it spawns** and reconciled against actual usage when it
    finishes. The loop runs tool calls sequentially today, but `parallelTools` is advertised and
    this tool is public API: a gate read before an `await` and written after it is not a gate.
  - because the pool reserves, the CLI gives each child a **share** of the parent's budget
    (`maxTokens / maxChildren`), not the whole of it — otherwise the first subagent would be the
    only one that could ever run.
- **Pool eviction is by last use and never touches a live pool.** Sessions are never announced as
  finished to a tool, so the map is capped (256); evicting the oldest *inserted* entry would
  target the longest-running session and hand it a pool with its limits back at zero.
- **The same permission policy object *and* the same asker.** A subagent that could do more than
  its parent would be a permission bypass with extra steps; a subagent that can do less is the
  failure the first version had — `AgentConfig.onAsk` defaults to deny, so under the TUI a child
  could not write a file, was never prompted about it, and had no way to say why. The child's asks
  now route through the parent's prompt carrying `PermissionRequest.origin = "subagent"`. That is
  set on the child's **`AgentConfig`**, not wrapped around `onAsk`, so the emitted
  `permission.request` carries it too — the prompt, the log, `renderEvent` and `sessions show` all
  agree on who asked. Only whoever builds a session can set it; a tool or a model cannot.
- **The parent's abort reaches the child**, and `subagent.end` is emitted on the abort path rather
  than after the event loop: by the time the loop unwinds the parent has ended and its events are
  dropped, which left a `subagent.spawn` in the log that no `subagent.end` ever answered.
- **The parent logs the child before the child starts.** `Agent.run` takes an optional
  pre-allocated `id` (from `store.create()`) so `subagent.spawn` can name a session that has not
  written anything yet; a trace read in order never shows a session that came from nowhere. Two
  runs appending to one id would restart `seq` and leave a log that cannot be read back at all, so
  a fresh run now **claims** its id for its lifetime (in-process; the resume path's advisory file
  lock covers the cross-process case), and `store.create()` never returns an id it has already
  handed out.
- **The last turn that *said* something is the answer, and a preamble is labelled as one.** Keeping
  only the final turn's text meant a child that stated its conclusion and then made one more tool
  call — normal, and not something a system prompt prevents — reported "the subagent finished
  without a final message". But an opening remark is also text, so when the kept text did not come
  from the child's last turn the parent is told so, rather than handed a preamble as a conclusion.
- The tool is `exec`: a child can do anything its tools can do, so claiming less would let
  `--allow read` run arbitrary writes through one.
- A child that ends on anything but `done` is reported to the parent as an **error**, not as an
  answer, and a child that says nothing is reported as such rather than as an empty result.

### Skills

- **Index-first, like the wiki, for the same reason.** A project may have twenty skills of a
  thousand words each; injecting them all would cost more context than the task. The system prompt
  carries name + description one line each, and the body is fetched through the `skill` tool only
  when the model decides one is relevant.
- **The description is what the model chooses on**, so a skill without one falls back to the first
  heading or line of its body rather than showing an empty entry it cannot reason about.
- `<name>.md` or `<name>/SKILL.md`; a nested skill is named by its **directory**, since the file is
  a fixed marker.
- **The first root wins**, so a project skill shadows a global one of the same name — the order a
  user expects. Shadowing is matched **case-insensitively**, because the `skill` tool looks up that
  way: keeping both `Deploy` and `deploy` advertised two skills and served one body for both.
  A shadowed skill is reported through `onError` rather than silently dropped.
- **What reaches the system prompt is untrusted input, and is treated as such.** A name and a
  description are stripped of C0/C1 control characters *and* of zero-width and bidi formatting
  (U+202E can visually reorder the rest of a line), bounded to 80 / 200 **code points** so
  truncation cannot leave a lone surrogate, and the catalogue as a whole is capped at 8 KiB
  **measured in bytes** — a cap counted in UTF-16 units lets a CJK catalogue through at ~3× what
  it claims. A directory name may contain newlines — enough to
  forge a second `## Skills` section with entries nobody wrote — and a frontmatter `description:`
  may be 60,000 characters that ride in *every* request.
- **Symlinks are not skills.** Discovery `lstat`s and skips them: `skills/notes.md -> ~/.ssh/id_rsa`
  would otherwise put the target's first line into the system prompt of every request, with no
  model decision involved.
- **A subdirectory with no `SKILL.md` is not an error** — `--skills .` on a repo root would
  otherwise report one failure per `.git`, `node_modules` and everything else.
- **The `skill` tool reads only what was already discovered**, keyed by name into a fixed map, so
  there is no model-supplied path to traverse. Bounded by file size and count.
- **Caveat: skills are discovered once at startup.** Editing one mid-session has no effect until
  the next run.
- **Caveat: nothing validates a skill's *body*.** Names and descriptions are sanitized because they
  reach the prompt with no model decision; a body only arrives when the model asks for it, and is
  then shown verbatim. A skill is as trusted as the repository it lives in.
- **Subagents get the skills too** — the `skill` tool and the catalogue — since a child doing a task
  the project has instructions for should be able to load them.

## The output surfaces (from the first real interactive run, 2026-08-30)

- **Neither surface ever showed the model's reply.** The TUI skipped `model.delta` as per-token
  noise and `agentrig run` skipped it for the same reason — and nothing else carries the text, so
  a session that answered a question printed `session.start`, `turn.start`, `model.request`,
  `model.response`, `turn.end`, `session.end` and no answer. The one live run that *looked* like
  it worked only did so because the answer happened to appear inside a `tool.result`.
  `AssistantText` now gathers the deltas and emits them once per turn; the TUI also streams the
  turn in progress live and commits it when the turn ends.
- **The default view is the conversation, not the trace.** `renderChatEvent` shows the reply, what
  the agent did (`⚒ bash pnpm test`), files it changed, plan progress, supervisor signals, errors
  and anything that ended badly — and hides session/turn/model/permission-decision/compaction
  plumbing. `renderEvent` is unchanged and is what `--verbose` (and the TUI's `/verbose`) shows.
  `--json` is untouched: machine consumers still get every event.
- The two views are deliberately separate functions over the same event stream rather than a
  filter over rendered strings, so what a person reads and what a debugger reads can diverge in
  shape without either drifting from the log.

## Windows notes (from the first real desktop run, 2026-08-30)

- **CRLF was a silent edit-breaker.** `read_file` and `grep` split on `\n` only, so on a CRLF
  checkout — every clone on Windows — each line reached the model with a trailing carriage return
  (`"1\t# AgentRig\r"` in a live trajectory). The model then copies what it was shown into
  `edit_file`'s `oldText` with plain `\n`, which matches nothing in the file, and *every*
  multi-line edit fails with "oldText not found". Both tools now split on `/\r?\n/`, and
  `edit_file` retries a failed match with the line endings converted — in both directions —
  converting `newText` the same way so the file keeps the endings it had. An edit must not
  rewrite every line of a file as a side effect of matching one.
- **The `bash` tool runs `cmd.exe` on Windows.** It spawns with `shell: true`, so a model's
  bash-isms (`ls`, `&&`, POSIX quoting) may misbehave. **Open — follow-up F2**, because choosing a
  shell changes what every trajectory in a repo means and is a decision rather than a patch.
- **Process-group kill degraded to killing one process (fixed).** Timeout and abort called
  `process.kill(-pid)`, which Windows does not support: it threw, and the fallback killed only the
  direct child — so `cmd.exe` died and whatever it started kept running, holding the stdio pipes
  past the timeout that was supposed to end it. Windows now uses `taskkill /pid <pid> /T /F`, and
  the child is **not** spawned `detached` there: on Windows that means "survive the parent, in a
  console of its own" — a flashing window per command and a child that outlives the session — with
  no process group to gain, since Windows has none.
- **The token file was not ACL-protected (fixed).** `chmod(0o600)` only toggles the read-only bit
  on Windows. `FileTokenStore` now runs `icacls <path> /inheritance:r /grant:r <user>:F` after
  writing, best-effort: a credential that could not be locked down is still a credential the user
  needs, so a failure warns once — naming the command to run by hand — rather than failing the
  login. **Unverified on real Windows**: the branch is unit-tested with an injected runner, the
  `icacls` call itself has not been observed to succeed.

## Decided

- Lore is an optional `MemoryBackend` behind the seam in PLAN.md §3.8; the wiki stays the source
  of truth and the default stays no-infra (milestone 3b).
- AgentLens is a future sink for the event stream (observability), not a memory dependency.

## Follow-ups (PLAN.md §9)

Recorded rather than built, each with a working path in the meantime:

1. **F1 — PKCE + loopback login for `openai-chatgpt`.** The device-code flow cannot work from any
   Node process (Cloudflare challenges the client, not the location). Until then: seed the
   credential from Codex's `~/.codex/auth.json`, which the file store and the env var both read.
2. **F2 — a configurable shell for the `bash` tool.** It runs `cmd.exe` on Windows, and models
   write bash. Choosing the shell changes what every trajectory means, so it is a decision, not a
   patch.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Dogfood repo after AgentRig itself
