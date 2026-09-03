# Status

Current roadmap row: **R3d is complete; R3 is complete (R3a–R3d); R4a is next.** R2 is complete (R2a–R2d); R1 is complete (R1a–R1e); R1.5a–R1.5f are complete.
The original milestones M0 through M7 remain complete, including M2.5's live provider validation.

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

## Release-train policy

- The checked-in `topic` skill changes multi-row roadmap bands from a per-PR merge word to one
  explicit human authorization up front. That invocation applies only to the named band's fixed,
  ordered row list and is preserved verbatim in each landed PR description, squash body, and the
  parent's final report. Each row still gets its own branch from the CI-green merged predecessor,
  dogfood builder, isolated independent review, conditional land, and post-merge `main` CI watch;
  this is sequential land-as-you-go, never a stack of open PRs.
- The authorization is bounded by fail-closed stop conditions. MEDIUM/HIGH findings, unverifiable
  review claims, merge conflicts, red CI on the actual PR head or post-land `main`, and children that
  exhaust their budget all halt the train for a human. LOW findings are never waived or skipped: the
  train gives them one narrowly scoped fix child and one delta re-review, then lands only on a clean
  result or halts. The train never rebuts a finding on its own. A preflight reserves five child
  slots per row and requires at least 60 turns per child; because pool size divides a configured
  parent token cap, that cap must rise proportionally (or remain unset). Undersized runs halt before
  branching. A TUI topic train must start after `/new`, keeping its raw human invocation as the
  non-compactable first message in a provenance-labeled block; repository-authored delimiter lines
  are neutralized. Subagent results expose the child's session
  id, which the conductor immediately restates before tool-result eviction can remove it.
- Caveat: unattended bands run unsandboxed until R2 lands. Up-front authorization removes repeated
  merge pauses; it does not add OS isolation. Use this mode only in an environment whose current
  unsandboxed execution risk is acceptable, and treat any halt as a successful safe outcome.

Second `/topic R2` run (halted at R2b on a HIGH contract finding): the halt rule keyed on severity,
and severity is not fixability. The rule is now: any finding that carries a concrete proposed fix
is repair work whatever its severity; a contract/authorization finding is arbitrated first and the
fixer carries the verdict; an unverifiable claim is fixed with evidence or by deleting the claim;
only a finding with no fix, or an arbiter "needs the human", halts. `ship` says the same for its
human-requested fix round.

Third `/topic R2` run: R2c landed unattended, R2d halted after its one repair round because the
delta reviewer found a second test gap — with the fix in its own report. That halt was the rule
being wrong, not the train: the train had stopped on a finding a child could close. `topic` §3 is
now a bounded converging loop (at most three repair rounds per row, each must close the previous
round's findings, residual LOW/MEDIUM lands recorded, residual HIGH halts), a reviewer or fixer that
dies is replaced once, a stale head gets a fresh reviewer, a finding with no proposed fix is the
fixer's to find. The only halts left are listed at the end of the skill. The child pool is sized for
the band rather than reserved per row; set `subagentMaxChildren` to at least nine per row you want
to survive three rounds.
Residuals are GitHub issues, never PR-body prose: after the third round the last fixer files one
`review-residual` issue per open finding and lists the numbers under `## Residuals`; the lander
refuses a PR whose residuals lack issue numbers. dogfood and ship say the same for anything a
review found that the PR does not fix.
First `/topic R3` run halted R3a after repair round 2 because the round "started with one finding
and ended with one" — but the one it ended with was new, in code the fix touched, and the given
one was closed. The convergence rule counted; it now asks only whether the given findings closed
and none reopened. A new finding is the next round's work until the cap.

## Abort grace: a parent waits for the children its abort orphaned (#86)

`control.abort()` raced past a running tool via `raceAbort`, so a parent's `session.done` resolved
while a subagent it had aborted was still writing its snapshot and `session.end`. Readers of the
child's log in that window (`sessions show`, the abort test) saw a session with no end; the test
flaked roughly one run in five. The loop now keeps the promises an abort orphaned and, in its
`finally`, awaits them before the snapshot, `session_end` hooks, and `session.end`, bounded by
`abortGraceMs` (default 1s). Past the grace it ends anyway and records a non-fatal `error` naming
how many executions were still running. No new event type; no-op on a session that was not aborted.
The default is deliberately short: an aborted child finishes its log in milliseconds (its hooks
are skipped, see #88), and the existing "abort wins over a tool that ignores its signal" contract
means an abort must not sit behind a hung tool for long — a 10s draft made those tests time out.
If #88 makes `session_end` hooks run on abort, a child in a slow ingest will outlive this grace and
be recorded as still running, which is honest but worth revisiting then.

- Rejected: fixing only the test by polling the child's log. The observable contract — a parent
  that says "aborted" has no running children — was the thing that was false.
- Rejected: an unbounded wait. A child inside a long `session_end` hook would hold its parent's
  abort open for the hook's full budget; the grace keeps abort responsive and the record honest.
- Tests hold the child's end open at its store (`GatedStore`), not with a slow `session_end` hook:
  an aborted session skips its hooks entirely (`runHooks` returns at once on an aborted signal),
  which also means memory ingest never runs for an aborted session — filed as #88.
- Review findings folded in: the grace timer is deliberately NOT unref'd — a first draft unref'd
  it, and in a bare process (not under vitest) Node exited mid-grace with no snapshot and no
  `session.end`, exit code 0; a subprocess test (`test/fixtures/abort-exit.ts` under tsx) pins it.
  A subagent child gets half its parent's grace, otherwise a child waiting as long as its parent
  always finished after the parent gave up on it. The subagent tool now aborts a child spawned
  into an already-aborted signal (a listener added to an aborted signal never fires; the child ran
  its whole budget). The record names what was orphaned (`tool <name>` or `compaction`).
- Costs to know: aborting a tool that ignores its signal, or a hung compaction call, now takes up
  to the grace (1s) and records one non-fatal `error`; the bash tool honours its signal, so a
  Ctrl-C on a normal command still lands in milliseconds. A tool orphaned by the abort can still
  emit during the grace, so its events (a `file.changed`, a `subagent.end`) land after `turn.end`
  and before `session.end` — more faithful than dropping them, and the supervisor's detectors do
  not count `error` events, so the record cannot escalate a normal abort.

## Deviation gate and repair-round change (skills)

The first `/topic R2` run landed R2a and halted on R2b. Two things went wrong in the halt and both
were process, not code:

- The train rewrote its own contract. The R2b row said `docker` + `seatbelt`; the expansion listed
  "Seatbelt and Bubblewrap", the builder implemented that and edited the roadmap row to match,
  calling the original a "superseded draft". Nothing on `main` had ever mentioned Bubblewrap. The
  reviewer saw the roadmap diff and did not flag it.
- The train halted on two MEDIUM findings that came with concrete fixes. The halt rule was
  severity-based; the thing worth bounding is the number of repair rounds.

Changes:

- New `arbiter` skill: a second agent with fresh context judges one proposed deviation from a
  contract (row, issue, task) and returns `VERDICT: APPROVE|REJECT` with a RECORD line naming the
  exact roadmap/issue text. Its bar: intent preserved, inside the human's authorization, reason is
  a verifiable fact, change recorded as a reviewable diff. Scope reductions and security-posture
  changes are always "needs the human".
- `dogfood` §2 deviation gate: a builder never edits the row it implements without an arbiter
  record. Standalone it spawns the arbiter itself; under `ship`/`topic` it cannot (children do not
  nest — `maxDepth` is 1 and there is no flag), so it pushes, stops, and ends its report with
  `DEVIATION REQUESTED`; the conductor arbitrates and spawns a continuation builder. PR bodies gain
  a `## Deviations` section.
- `review` §4 contract fidelity: a deviation without an arbiter record is a HIGH finding regardless
  of merit; merit is judged separately so the human sees both.
- `topic`: rows are copied verbatim from `origin/main` at expansion and quoted to children; one
  arbitration per row; the repair round now covers LOW and MEDIUM findings that carry a concrete
  fix, while HIGH, design/contract/authorization findings, and unverifiable claims still halt. The
  one-round cap and "any delta finding halts" are unchanged.
- Consequence to know: under `topic`, an arbiter-approved deviation lands without the human. The
  PR body carries the verdict block so it is visible at a glance; if that is too much autonomy,
  make `DEVIATION REQUESTED` a halt instead of an arbitration.

- **#95 — a forged or host-caused "read-only file system" line classified as a denial.** No
  provider can authenticate a child's stderr, so classification is now corroborated against the
  policy: `deniedPath(line)` reads the path a denial names (quoted, else the first absolute
  token), and `writeDenialPlausible(line, policy)` rejects a write denial naming a path inside a
  `workspace-write` workspace, which is writable and so could not have produced it (docker's
  "read-only file system", seatbelt's `file-write*` denials). Paths are normalised (`..`, relative
  to cwd) and the boundary is the directory, never its prefix. A line naming no recognisable path
  keeps today's classification: corroboration narrows, never widens. A forged line naming a path
  outside the workspace still classifies, and that is the boundary's own verdict on that path: the
  sandbox would deny that write, and the escalation prompt (which yolo never auto-answers: it goes
  to `onAsk`, denied headless) shows the provenance label. Mutants killed: docker ignoring the
  corroboration; a prefix sibling counting as inside; no path normalisation; seatbelt ignoring
  the corroboration.

## R3 notes

| Row | Deliverable | Status |
|---|---|---|
| R3a | `session.fork` event, append-only child creation, and recursive event/message materialization | done |
| R3b | Session fork/search CLI and bounded replay | done |
| R3c | TUI `/fork` and `/tree` | done |
| R3d | Live `/children` tree | done |

- R3a adds `SessionStore.fork(parent, atSeq)`: the child log contains only its seq-0
  `session.fork` record, while the parent log and existing snapshot behavior remain untouched.
  Fork points address the named parent's physical log, so recursive materialization naturally
  supports forks of forks without flattening or copying ancestry.
- `SessionStore.materialize` returns inherited recorded events followed by the child's records;
  `materializeMessages` folds that stream into provider-neutral messages. Additive `message.append`
  records preserve the exact assistant/tool-result boundaries used by the model, and
  `context.compact.messages` preserves authoritative post-compaction state. Historical logs retain
  the original event fold. Recorded tool results and both `modify`/`inject` patches replay directly;
  tools are never looked up or executed during replay.
- Fork child ids are reserved with exclusive on-disk creation. Reopened stores retry collisions
  without changing the existing log, preventing a second seq-0 record from entering another session.
- Acceptance coverage diffs parent/child message lists at the fork point, follows two levels of
  ancestry, hashes the parent file across child creation, rejects nonexistent fork points before a
  child is written, compares a real parallel-tool plus compaction run to its stored message state,
  preserves colliding files byte-for-byte, covers both patch modes, and uses a counter tool fixture
  to prove materialization does not repeat effects. No roadmap deviation was needed.
- R3b adds `sessions fork <id> [--at <seq>]`, defaulting to the final event in the parent's own
  physical log; `sessions replay <id> [--until <seq>]`, which renders the side-effect-free
  materialized tree; and `sessions search <query>`, which runs the memory package's existing BM25
  scorer over those same rendered materialized transcripts. Sequence options reject non-negative
  integer violations at argument parsing, and no scorer move or dependency-boundary change was
  needed.
- R3c adds `/fork [seq]` and `/tree` to the TUI. `/fork` writes a child log holding only its
  `session.fork` marker and switches the conversation to the child; the next prompt resumes the
  child, so the parent's log never gains a byte (the controller test hashes it across the fork and
  the child's first turn). `/tree` prints the root-to-current ancestry and every fork under the
  root. Discovery is `SessionStore.tree(id)` in core (the CLI keeps only the renderer, which R3d
  will drive with live state): the parent records nothing about its forks because it is never
  written, so children are found by reading the first event of every log in the store. A log
  that does not parse is skipped and named under `unreadable`, never fatal — one stray file must
  not take `/tree` away from every healthy session — while the named session and its ancestors
  must parse. Cycles terminate: a marker naming itself is nobody's child, and two markers naming
  each other render once. Both commands are injected into the controller like `/memory` and
  `/dream`, so it stays free of stores; the TUI wires them to a `SessionStore` on the agent's root.
- Decision beyond the row, in core: a fork child had no snapshot until it completed a turn, so
  `sessions fork` produced an id that could be replayed but never continued — `run --resume
  <child>` died with "no snapshot found", and `/fork` would have too. Resume now falls back to
  `SessionStore.materializeSnapshot(id)`, which exists only for logs opening with `session.fork`
  and folds the materialized tree into a snapshot (messages, the latest task and cwd from
  `session.start`/`session.resume`, turns from the last `turn.end`, usage summed over
  `model.response`; a test compares every field against a written snapshot). Caveat: `usd` is
  the one field no event records, so a fork child resumed without explicit pricing starts its
  USD budget at zero where a written snapshot carries the parent's figure — token budgets are
  unaffected. A plain session with no snapshot is still an
  error — "died before its first turn.end" must not become "resumable from nothing" — and the
  restored messages go through the same open-tool-call synthesis a written snapshot gets, because
  a fork point can sit between a `tool.call` and its result. Nothing executes: it is the R3a
  materializer, and the call-counter fixture pins that the resumed child runs no recorded tool
  again. Mutants killed: dropping the fallback, dropping the tail synthesis, widening the
  fallback to non-forks, not switching the TUI session, allowing `/fork` mid-turn, dropping the
  cycle guard, keeping a self-parent as a child, making an unreadable log fatal, taking the first
  task instead of the latest, not marking the fork resumable.
- Skills: the land skill now checks the completed row carries `*(done)*` (the LOW #101's delta
  review found, made a precondition rather than a memory).
- R3d adds `/children`. The controller records which children exist from the parent's own
  stream (`subagent.spawn` gives the id and label, `subagent.end` the reason); everything else —
  the turn it is on, the tool it is in, the plan item in progress, when it started and ended, the
  children it spawned itself — is read from each child's own log by `liveChildren` in core, which
  folds the log with `summarizeSession` and follows the child's own spawn records to
  grandchildren, visited once. Nothing is written and nothing is copied into the parent's log
  (the test compares the parent's byte count across `/children`). One line per child: `id ·
  label · turn N · <tool> <since> · plan: <item> · <elapsed>`; a finished child shows the
  parent's `subagent.end` reason and its duration; a child with no log yet is "starting"; a log
  torn mid-line (the child is still writing it) is reported on that line rather than failing the
  command. Nested children render as an indented tree through the same `renderTreeLines` that
  `/tree` uses.
- Decision beyond the row: `/children` reads the logs when invoked rather than repainting on a
  timer. Every invocation is a fresh read of the source of truth, so what it prints is the state
  at that moment; a self-refreshing block would need the live frame to hold N growing lines,
  which the viewport design (`viewport.ts`) budgets against, and the scrollback is `Static`. A
  timer-driven view is a follow-up if dogfooding asks for it.
- Review fixes, each pinned: a `tool.result` closes the open call (a child thinking after `bash`
  is not "in bash"); `/children` has no running-turn guard, and a test invokes it while the child
  is blocked inside a tool; a torn last line — a child mid-write — keeps every line before it and
  is flagged "log still being written" (`SessionStore.readPrefix`), while a corrupt terminated
  line or a seq gap is still an error; `/resume <other>` drops the previous session's children and
  seeds the list from that session's own log (`onSpawned`), or starts empty when nothing is
  wired; a child log whose spawn record names the parent or a sibling cannot pull that session
  under itself — the walk is breadth-first and every id found at one depth is claimed across
  all branches before the next depth is read, so a record cannot steal a session of the same or
  a shallower depth from another branch either; a record naming a session that truly belongs
  strictly deeper in another branch is undecidable from child logs alone (residual issue, see
  the PR) — and an id that is not a session id renders as "invalid id"; every `subagent.end` reason the log can carry is
  recorded, "ended" when it carries none (`applyChildEvent`, exported and tested directly).
- Mutants killed: a session that ended still "in" its last tool; a `tool.result` leaving the
  call open; dropping the visited guard on looping spawn records; a torn tail throwing; no
  up-front claims for parent and siblings; throwing on an unreadable child log; not recording
  `subagent.end`; a hard-coded end reason; a resume keeping the previous session's children; a
  running-turn guard on `/children`; preferring the child's own end reason over the parent's.

## R2 notes

| Row | Deliverable | Status |
|---|---|---|
| R2a | Core `SandboxProvider` execution seam, three sandbox modes, and `sandbox.denied` event | done |
| R2b | Concrete no-op, Docker, and macOS Seatbelt providers | done |
| R2c | Sandbox-denial escalation with one approved unsandboxed retry and distinct TUI prompt | done |
| R2d | CLI/config sandbox selection, composed `--yolo` guidance, Docker fixture CI, and Windows no-op CI | done |

- R2d adds `--sandbox read-only|workspace-write|none` and the matching validated config key to both
  agent entry points. Linux selects Docker, macOS selects Seatbelt, and `none` selects the explicit
  identity provider on every host; unsupported enforcing modes fail closed. Parent and subagent
  configurations carry the same boundary independently of their shared approval policy.
- The `--yolo` warning now distinguishes an absent boundary from an active sandbox and explicitly
  recommends skipping approvals inside `workspace-write` for unattended runs. Boundary escalation
  remains a separate explicit prompt even when ordinary approvals are skipped.
- CI pre-pulls `alpine:3.20` on Ubuntu so the network-free Docker integration test runs live. A
  Windows job builds and typechecks all packages, then runs the focused `sandbox=none` identity-seam
  proof; it does not misrepresent POSIX-only process integration tests as Windows coverage. The local
  Docker test still skips loudly when Docker or the pre-existing fixture is absent.
- R2d's focused wiring/config/warning tests passed, the existing fake-provider outside-cwd acceptance
  and single-retry tests passed, and a mutant permitting a second unsandboxed retry was killed by the
  cap test. No Landlock is introduced in R2.
- R2d dogfood token usage is unavailable in this API-runner session rather than fabricated.

- R2c turns an explicit provider `SandboxDeniedError` into a second-axis permission request with
  `origin: "sandbox-escalation"`. Core records the denial, asks explicitly, and on approval invokes
  the original validated command outside the provider exactly once; denial retains the failed tool
  result. A provider-shaped failure from the unsandboxed retry is an ordinary tool failure and cannot
  reopen the prompt, pinning the single-retry cap.
- TUI sandbox escalation says “blocked by sandbox — run outside it?” and offers only a one-call grant.
  Standing allow/deny answers for the tool neither answer this prompt nor get replaced by its answer,
  preserving sandbox and ordinary permission as independent axes. Headless runs have no `onAsk`, so
  escalation fails closed. No Landlock is introduced in R2.
- Acceptance coverage uses a fake model and sandbox to attempt an actual write outside the run cwd,
  observes `sandbox.denied` and the escalation request, approves it, and verifies the outside file and
  successful retry. A second-denial mutant is pinned to one prompt and one unsandboxed execution. The
  R2b Docker prerequisite gate and Seatbelt profile-shape tests remain the provider acceptance seams.
- R2c dogfood token usage is unavailable in this API-runner session rather than fabricated.

- R2b adds an explicit identity provider while keeping omitted sandbox configuration equivalent to
  today's behavior. Docker runs process tools with a read-only root, a cwd bind that follows the
  selected filesystem mode, and `--network none` unless network is separately granted. Seatbelt's
  generated deny-default profile permits reads/processes, scopes writes to cwd only in
  `workspace-write`, and denies network unless separately granted.
- Foreground and background shell launches consult the active provider at the process boundary.
  Backend-specific denial text is converted to `SandboxDeniedError`; ordinary non-zero command
  exits retain their existing tool-result behavior. Docker's live integration test first requires
  `docker info` and a local fixture image, prints a prominent reason, and skips rather than failing
  when either prerequisite is absent; it never pulls during the test. Seatbelt profile shape is
  tested without requiring nested macOS sandbox support.
- R2b does not add selection flags/config or the outside-sandbox retry path: those remain R2d and
  R2c respectively. No Landlock or substitute Linux-native backend was added.
- Deviation, arbitrated and recorded (see PR #90 `## Deviations`): the docker integration test is
  gated behind `docker info` *and* a locally present fixture image, never pulling, because tests
  are network-free and `docker run` would implicitly pull; R2d's CI pre-pull makes the live test
  run on the ubuntu leg. The R2 acceptance text carries the arbiter's RECORD line.
- Skill change riding along (attended PR, human-visible): dogfood §8's "record, never fix" cap
  now bounds review rounds, not fixes — a LOW the delta reviewer finds may be fixed post-delta
  with a fail-first test and a killed mutant, labelled "post-delta, self-verified, not
  re-reviewed" in the PR body; MEDIUM and above stay record-only; `topic` stays record-only
  because nobody reads a label on an unattended train. `ship` mirrors it.
- Review repairs: no provider can authenticate a child's stderr, so classification is narrowed to
  what the active policy would produce — generic "operation not permitted" is never a denial, and
  "network is unreachable" only counts when the policy denies network — and the denial reason is
  labelled as the command's own unauthenticated words, so the R2c escalation prompt cannot present
  child output as the sandbox speaking. Background jobs classify from a retained tail of
  everything the job wrote, not from the last poll's drain, so a denial printed early and drained
  by an intermediate `bash_job` status is still reported at exit, once.
- Post-delta-review fixes (self-verified with fail-first tests and mutants, not re-reviewed by a
  second agent — the human saw that label at merge): classification runs before the poll drains,
  so the poll that reports a denial no longer swallows the output that arrived with it; the
  registry retains the job's first 4 KiB as well as its last, so a denial ahead of a long log is
  still classified; seatbelt drops a network denial under a network grant, matching docker. Not
  fixed, inherent: a forged or ambiguous "read-only file system" line under `workspace-write`
  still classifies — the provenance label is the mitigation, and R2c must keep it in the prompt.

- R2a models a sandbox command as a deferred tool execution. After ordinary permission approval,
  core passes that command and `{ mode, cwd }` policy to the configured provider and executes the
  returned wrapper. A denied permission never reaches `SandboxProvider.prepare`, keeping approval
  and OS isolation independent rather than letting either layer stand in for the other.
- Providers identify an OS-enforced block by throwing `SandboxDeniedError`. Core then appends a
  bounded `sandbox.denied` record (tool id/name, active mode, and reason) before the ordinary failed
  `tool.result`; unrelated tool exceptions retain their existing behavior and are not mislabeled.
- Sandbox configuration is optional in R2a, preserving today's execution when no provider is wired.
  The `none` mode still traverses a configured provider seam. Concrete no-op, Docker, and seatbelt
  providers remain R2b; escalation/retry remains R2c; CLI/config wiring remains R2d.
- Rejected: infer sandbox denial from generic `EACCES`/`EPERM` tool exceptions. Host filesystem
  permissions can produce those without a sandbox, so only the boundary provider can classify the
  failure honestly. Also rejected: invoking the sandbox before permission policy, which would make
  denied calls enter an execution layer despite never being approved.
- Caveat: R2a establishes and tests the boundary but supplies no enforcing provider, so unattended
  runs remain unsandboxed until the later R2 rows land.

## R1 notes

| Row | Deliverable | Status |
|---|---|---|
| R1a | `AGENTS.md` discovery and system-prompt injection, with `CLAUDE.md` alias and `context.loaded` event | done |
| R1b | Zod-validated user/project config, named profiles, and explicit-source precedence shared by `run` and the TUI | done |
| R1c | TTY-scoped bracketed-paste mode with streaming marker decoding in the quiet-point input path | done |
| R1d | Realpath-keyed, fail-closed consent gate for project instructions and config, shared by run and TUI | done |
| R1e | Read-only `agentrig doctor` with actionable local diagnostics and scriptable exit status | done |

### Post-R1 TUI refinements

- Issue #55 adds a statusline working indicator derived entirely from the controller's live event
  stream: model requests show wall-clock `thinking Ns` until first output, and tool calls show the
  tool name (plus a bounded one-line command prefix for bash) until the matching result. A 1 Hz view
  clock updates elapsed time without adding core events. Its writes are suspended while bracketed
  paste framing is open or partial and coalesced into the existing quiet-point draw after completion.

- R1e ships the complete local checklist: effective provider credentials (environment presence or
  readable ChatGPT token source and expiry/time remaining), user/project config validity, active
  profile and provider/model precedence sources, trusted/untrusted/undecided project state, writable
  memory plus readable wiki index, MCP config plus command-on-PATH checks, informational Git branch/
  detached state, and stdin/stdout TTY capability. Every failure names a corrective command, setting,
  path, or permission repair; any failure exits non-zero, while informational skips do not.
- Doctor never prompts, writes, refreshes a token, or opens an untrusted project's config. Its
  filesystem, environment, clock, command lookup, project-boundary, and Git probes are injectable, so
  tests use no host credentials, HOME, PATH, or repository state. MCP protocol handshakes were
  deliberately left out: R1e diagnoses configuration and executable availability, and the roadmap
  explicitly does not require speaking the protocol.
- Rejected idea for R1e: instantiate `OpenAIChatGPTAuth` and ask it for current credentials. Its normal
  read path may seed the token file from the environment and its use path may proactively refresh and
  persist rotation, violating doctor's read-only guarantee. Doctor instead parses a snapshot through
  read-only probes and reports only source/presence/expiry, never token bytes or parser source context.
- R1e dogfood token measurement: the interrupted implementation attempt used **271,083 input tokens
  over 30 turns**. This resumed API-runner session exposes no provider usage telemetry, so its
  additional token count is unavailable rather than fabricated. Add 271,083 plus this unavailable
  continuation beside the **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1d stores interactive allow and decline decisions in `~/.agentrig/trust.json`, keyed by the
  project's canonical `realpath`; aliases and descendant working directories therefore share the
  same boundary. Core independently requires the run cwd to be at or below that canonical root and
  bounds instruction discovery there, while CLI resolves consent before opening project config.
  If a repository is the home directory or contains it, `~/.agentrig` is also repo-controlled, so
  user config and persisted trust are ignored and only invocation-scoped `--trust` can opt in.
- `--trust` applies only to the current invocation and is not persisted. This is deliberately the
  least-ambient interpretation: CI or a one-off automation command may opt into a reviewed checkout
  without silently granting all later interactive sessions permission to load that checkout.
- Missing trust state is untrusted. Malformed or unreadable `trust.json` warns and behaves as an empty
  trust store; headless run, headless TUI, and resume never prompt and visibly skip both project
  instruction names and project config unless a prior allow or `--trust` applies. A recorded decline
  is also visible and is not prompted again.
- Rejected idea for R1d: place consent in project `.agentrig/` beside config. That file would be under
  control of the freshly cloned repository whose claims are being evaluated, allowing the project to
  mark itself trusted. Consent therefore lives only in the user's home-level AgentRig state.
- R1d dogfood token measurement: this API-runner session exposes no provider usage telemetry, so its
  exact token count is unavailable rather than fabricated; add this unavailable point beside the
  **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1c holds any suffix that is still a possible `ESC[200~` or `ESC[201~` marker (including a bare
  `ESC`) across raw stdin chunks. When later bytes complete it, the marker is stripped; when they
  disprove it, the held bytes are released to Ink's ordinary key path, preserving fallback behavior.
  Drawing is suspended without a deadline while paste mode or a partial marker remains open, then
  one draw and any queued submit are released through the existing stdin quiet point.
- An unmatched `ESC[201~` is treated as protocol framing and stripped while remaining outside paste
  mode. This prevents a damaged or duplicated terminal wrapper from leaking marker bytes into the
  prompt. A `201~` sequence inside pasted payload necessarily closes the paste, as defined by the
  terminal protocol.
- Rejected idea for R1c: replace Ink's input handling with a new raw-stdin key parser. That would make
  bracketed-paste support reproduce every existing key and burst heuristic. The implemented side
  channel retains each exact raw chunk for marker decoding while Ink still supplies ordinary key
  semantics, so terminals that ignore `?2004h` keep the old path.
- R1c dogfood token measurement: this API-runner session exposes no provider usage telemetry, so its
  exact token count is unavailable rather than fabricated; record this as the next unavailable point
  beside the **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1b precedence is **CLI > environment > project config > user config > built-in defaults**. The
  only existing non-credential `AGENTRIG_*` setting is `AGENTRIG_MODEL`; credential environment
  variables remain provider/login concerns and can never be represented in config.
- Config merge is shallow by setting. In particular, `allow`, `deny`, drift-contract/scope, skills,
  and every other array replace the lower-precedence array rather than append to it. Appending can
  silently retain a user-level permission that a project intended to narrow, while replacement makes
  the effective policy locally legible. A selected profile overlays its own file's top level before
  the next file-precedence layer is applied. Relative path settings retain CLI semantics and resolve
  from the invocation cwd (the project root), not from whichever user/project config file supplied
  them; this keeps the same resolved value on `run` and TUI paths and makes a user default portable
  across projects.
- Rejected idea for R1b: infer whether a CLI option was explicit by comparing its value to the
  Commander default. A user may intentionally type the default value, so comparison loses source
  information; `getOptionValueSource` instead determines which values enter the CLI overlay.
- R1b dogfood token measurement: this API-runner session did not expose provider usage telemetry, so
  an exact token count could not be recorded without inventing one. This missing first post-eviction
  data point is noted explicitly beside the 1.7M/4.0M baselines rather than reported as a false value.

- R1a walks upward from the session cwd, prefers a regular `AGENTS.md` over its alias (directories
  and symlinks are not instruction files), preserves the file body verbatim between explicit
  system-prompt delimiters, and records the absolute path and file byte count without copying the
  body into the event stream or conversation messages.
- Considered Gemini CLI's trusted-project boundary from the studied harnesses, but deliberately did
  not implement it: the roadmap assigns trust and consent persistence to R1d, and pulling it into
  R1a would expand this row beyond discovery and injection.
- External-review stall measurement: no supervisor stall warning occurred during the external-review
  phase.

## R1.5 notes

| Row | Deliverable | Status |
|---|---|---|
| R1.5a | Outbound-view eviction of stale, large tool results with `context.evicted` accounting | done |
| R1.5b | Discounted cache-read budget accounting and cached-token usage displays | done |
| R1.5c | Mode-split turn defaults and fixed turns-remaining soft-warning threshold (issue #54) | done |
| R1.5d | Per-turn prompt bill of materials with hashes, provenance, freshness, and TUI `/context` | done |
| R1.5e | Budgeted mechanical repository map with mtime refresh, context accounting, and opt-out | done |
| R1.5f | Immutable-log overflow artifacts with bounded `read_output` range reads | done |

- R1.5b completes the cached-token path that already populated and accumulated the disjoint
  `Usage.cacheRead` field. Hard token budgets now count uncached input, cache reads, cache writes,
  and output exactly once. USD budgets charge cache reads at the provider-advertised input-price
  fraction (Anthropic reads 0.1 and writes 1.25; official OpenAI/openai-chatgpt reads use a
  model-family fallback of 0.1, 0.25, or 0.5), and conservatively use full input price when no
  provider/model discount is known. Explicit `--price-cache-read` / `--price-cache-write` rates
  override those defaults. The same accounting is used in the supervisor's soft limits, when
  reconciling bounded subagent pools, and when deciding compaction from reported usage.
- Human-facing headless, TUI, and event-trace usage lines show total input and identify a nonzero
  cache-read and cache-write subsets, for example `3.3M in (2.9M cached) / 12.3k out` and
  `182k in (180k written) / 500 out`; JSON remains schema-compatible and trace fields stay
  machine-readable (`in=`, `cached=`, `cacheWrite=`, `out=`). Counts are floored to one decimal so
  summaries never overstate measured use.
- Decisions beyond the row: cache discounts are additive optional provider capability metadata, so
  existing third-party `ModelProvider` implementations remain source-compatible. Unknown discounts
  deliberately fall back to full price rather than silently under-enforcing a USD budget. Cache
  writes are labelled separately because they are charged writes, not discounted reads. Tests pin
  both sides of discounted USD pricing (neither full-price nor free), explicit-rate overrides,
  exact-once hard and soft token-budget accounting, provider metadata, and compact displays.

- R1.5d emits `context.manifest` immediately before every model request, after outbound eviction,
  repository-map refresh, and `pre_model` hook patches. Each rendered system/history/tool-result/tool
  catalogue block records source, origin, instruction-vs-data authority, a 16-hex SHA-256 content hash,
  load reason, UTF-8 bytes, a conservative bytes/4 token estimate, kept-vs-evicted disposition, and
  freshness where applicable; the event also hashes the complete unified request. Bodies remain only
  in the outbound request, never the immutable JSONL log. The exact `context.repo_map.freshness` marker
  is threaded into the corresponding manifest block rather than recomputed. CLI assembly labels base
  instructions, skills catalogue, and memory index separately; trusted project instructions and repo
  maps are labelled in core. TUI `/context` renders the latest manifest.
- Compactness measurement: a representative first-turn manifest with base prompt, skills, memory,
  an 8 KiB repo map, one user-history block, and two tool schemas serializes to **1,338 bytes** including
  the event envelope. Prompt body size does not affect that cost; each later history/tool-result block
  adds one metadata record rather than duplicating content.

- R1.5f turns display overflow into a self-describing artifact without adding a second mutable store.
  `tool.result` gained additive `output` and `truncated` fields: only a result whose display actually
  overflowed carries its complete textual rendering, and the event's existing `seq` is the handle.
  The model-facing prefix remains within the 30,000-code-unit display cap after the handle is appended,
  carries an explicit complete-output cursor, and offers the immediately following range rather than a
  duplicate prefix. Non-prefix summaries/previews keep their meaning and page complete text from cursor
  zero. The distinct handle-bearing model view is recorded as a
  `tool.result.patched` event by `core:output-overflow` for replay/audit. `read_output {seq, from, to}`
  serves a zero-based, half-open range of at most 30,000 UTF-16 code units directly from the validated
  append-only session log, so hidden output can be inspected without replaying a command. Surrogate-pair
  splits are rejected with corrected offsets rather than returning malformed Unicode.
- `read_output` is registered by the core agent rather than by CLI/builtin assembly because it must
  capture the exact `SessionStore` used by the active session. Its session id comes only from
  `ToolContext`, never model input; a handle therefore cannot read another session. The name is reserved
  so caller tools cannot shadow this recovery path. It is explicitly allowed by the default policy: like
  `bash_job`, it only exposes data from an already-authorized operation in the same session and has no
  honest filesystem path with which to satisfy the generic cwd-only read rule. Tool-free agents do not
  advertise it. Reads stream the log instead of materializing every event and check aborts while scanning.
  A later replacing `post_tool` patch seals the raw artifact, so a redaction hook cannot be bypassed by
  range reads; inject-only patches carry an additive mode and leave recovery available. Hook output
  reserves bounded space for both result context and guidance rather than truncating the injection away.
  Overflow handles use one strict core marker and survive stale-result eviction. The core also applies the final display bound to
  third-party tools, thrown errors, and post-hook output, while `ToolResult.fullDisplay` plus an optional
  `displayPrefixChars` cursor lets already-bounded builtins and MCP tools preserve their own smaller caps
  and distinguish prefix previews from summaries/headers and from semantic collection caps such as grep's
  match limit. Empty/malformed `fullDisplay` values do not create artifacts.
- Rejected alternatives: serializing arbitrary structured `ToolResult.output` would not faithfully
  reproduce a tool's rendered text, and copying overflow into sidecar files would duplicate the raw log
  and create a second retention/trust boundary. A complete textual rendering is explicit at the tool
  seam instead. Caveat: ranges use JavaScript string indexing (UTF-16 code units), not UTF-8 byte offsets;
  callers should continue at the prior `to` value.
- R1.5f dogfood fixture: a 31,006-code-unit Unicode output persisted once, exposed a bounded next-page
  handle, and returned all hidden code units through `read_output`; the originating tool had exactly one
  call and the session ended `done`. Regression fixtures also pin redaction sealing, streaming reads,
  runtime and surrogate bounds, tool-free catalogues, stale-result handle preservation, core-view audit,
  thrown/hook output bounds, and malformed tool results. Mutation checks killed removal of `fullDisplay`
  persistence, replacement of the requested range with a prefix read, substitution of a different session
  id, removal of the default-policy allow rule, and both post-hook and thrown-error bounds.
- Review caveat retained deliberately: complete output is unbounded in JSONL and therefore inherits the
  size and machine-readable disclosure properties of the raw immutable session log. Capping it or hiding
  it from JSON replay would directly violate R1.5f's “full text from the raw log” contract; operators must
  protect raw logs accordingly. A future storage row may chunk append-only records atomically, but this
  row does not introduce a mutable sidecar or silently discard command output.

- R1.5e builds an 8 KiB-bounded, deterministically ordered file-and-export map with the TypeScript
  syntax parser only: no module resolution, imports, execution, LSP, or build graph. Conventional
  generated/state trees and every symlink are skipped. Function signatures and declared variable
  types are retained while function bodies and variable initializers are discarded, so orientation
  does not require whole-file reads and executable source cannot run during extraction.
- The map is appended to each outbound system prompt between conspicuous data-not-instructions
  delimiters. A per-session view compares a SHA-256 freshness marker over sorted path/size/mtime
  tuples before each turn and reparses only when that marker changes. It obeys the same canonical
  project-trust boundary as instruction files and excludes active session artifacts. Only `context.repo_map`
  accounting (bytes, file count, truncation, and freshness) enters JSONL; map content never enters
  messages or the immutable log. `--no-repo-map` and the boolean `repoMap` config key disable both
  injection and accounting for parent and subagent sessions.
- Rejected idea: persist the map in the session log and replay it on resume. The map is mutable prompt
  context, not raw history; persisting its body would inflate every replay, expose stale structure as
  current, and violate the same outbound-view boundary used by tool-result eviction.

- R1.5c keeps the interactive TUI at 50 turns but gives non-interactive `run` and `sessions resume`
  300 turns by default. A resumed session follows the entry mode doing the new work rather than
  inheriting its original cap. The split lives in Commander's per-command defaults so config,
  profiles, environment overlays, and flags keep their existing precedence; explicitness still comes
  from `getOptionValueSource`, which means a typed `--max-turns 50` remains an explicit choice even
  though 50 is also the TUI default. Three hundred was chosen over the roadmap's old 200 proposal
  because observed full-PR runs were already approaching 150 turns and user-side mitigation had
  validated 300, while raising the interactive cap would make an accidental runaway much costlier.
- R1.5c's budget warning now trips on the earlier condition of `supervisorSoft` or a fixed
  `supervisorTurnsRemaining` window (15 turns by default). The fixed window applies only to turns;
  tokens, USD, and minutes retain proportional thresholds because they have no turn-equivalent unit.
  Both conditions share the existing per-dimension one-shot latch, and the new value uses the same
  config/profile/CLI resolution path as `supervisorSoft` via `--supervisor-turns-remaining`. Resume
  events carry the cumulative completed-turn count (optional for old-log compatibility), so the
  supervisor can warn before the first new model request instead of learning the count after a
  near-cap resume has already spent its last turn.

- R1.5a was implemented before nominally-next R1b because the earlier measured work sessions cost
  3.3M and 4.0M input tokens on quadratic full-history resends. The first R1.5a session itself cost
  **1,718,936 input tokens over 43 turns** and died twice on provider overloads; the retry layer now
  on `main` addresses those transient in-stream failures. The required review continuation ran as a
  fresh session and cost **669,418 input tokens over 34 model turns** through final delivery.
- Eviction is a pure outbound request view. The live conversation, append-only session log, raw
  sources, compaction input, and resume snapshot retain full tool results; stale large results are
  replaced with pairing-preserving re-fetch stubs only in the request sent to the provider. The most
  recent five assistant turns and results whose serialized JSON payload is at or below 8 KiB remain
  verbatim by default.
- Rejected idea: replace stale results in the live `messages` array to avoid rebuilding a shallow
  request view each turn. That would make snapshots and resume lossy, feed synthetic stubs into
  compaction, and violate the event-sourced log's complete-history contract; bounded view allocation
  is the safer tradeoff.

## Supervisor ladder incident fix

Status: **done**.

- The R1a work session could not write its own ending: during final verification, four stall signals
  fired on varied `git status` / `git diff` / build-test-typecheck and known-file reading stretches.
  The ladder accumulated those separately resolved signals through guidance, replan, escalation, and
  abort, killing the session at 81 tool calls while the repository-required green check was running.
- Varied consecutive tool inputs now reset the stall detector's quiet-turn tally, while an identical
  command repeated without progress remains quiet and can still signal. Ladder recurrence advances
  only when no file change followed the prior intervention for that signal type; durable progress
  resets that type to guidance, while command variation alone cannot forgive a periodic loop. Abort is opt-in through
  `--supervisor-abort` on both `run` and the TUI; `--supervisor-no-abort` remains a documented no-op.
- Rejected idea: disable or substantially lengthen the stall threshold during verification. That
  would hide genuine same-command loops and make detection depend on guessing which commands are
  "verification"; comparing input identity preserves the ladder's teeth without command-name
  special cases.

## First checked-in skill: `dogfood` (2026-09-01)

Status: **done**.

`.agentrig/skills/dogfood/SKILL.md` — the end-to-end shipping flow (fresh branch → green trio by
real exit codes → docs → PR → two parallel external reviews via background jobs → fix all
findings fail-first → stop at the PR, never merge), distilled from this project's accumulated
dogfood lessons. Auto-loaded in every trusted session via #61's discovery. `.gitignore` was
restructured (`**/.agentrig/*` + re-includes) because git cannot re-include below an excluded
directory — session logs and wikis stay ignored at every depth, only `/.agentrig/skills/` is
tracked. A core test now guards the repo's own skills: frontmatter must parse and names and
descriptions must fit the catalogue bounds untruncated, so a skill edit that would degrade every
future run fails CI instead.

## Skills auto-discovery — issue #61 (2026-09-01)

Status: **done**.

`loadRunConfig` now appends the conventional skill directories after any explicit `--skills`
dirs — `<trusted project root>/.agentrig/skills` first, then `~/.agentrig/skills` — so projects
carry their skills with zero flags and R6b's generated skills get picked up the next session.
Ordering matters and is pinned: `discoverSkills` is first-root-wins, so explicit dirs shadow
discovered ones. Trust boundary: the project dir loads only under the same R1d decision as
AGENTS.md and project config (an untrusted checkout contributes no skills); the user dir is
skipped when the repository contains the home directory (`userStateSafe`), like user config.
Opt-out via `skillDiscovery: false` in config or `--no-skill-discovery` (with `--skill-discovery`
as the positive override, the paired-negation pattern) — named that instead of the issue's
`--no-skills` because Commander would let `--no-skills` clobber the repeatable `--skills` array
type. `agentrig doctor` gains a read-only `skills` line naming which dirs a run would load and
why the skipped ones are skipped — and says "unknown" while config is invalid rather than
asserting dirs a run would never reach. Discovered dirs are deduped against explicit ones.
Pinned by discovery-order, untrusted-checkout, home-inside-repo (with and without `--trust`),
nested-cwd-vs-trusted-root, dedupe, opt-out, flag-override, and doctor tests. Mutation-verified,
including the two gaps the adversarial review found surviving the first round: discovery removed
fails 3, trust gate removed fails 1, order inverted fails 1, unconditional home append fails 1,
`join(cwd)` instead of the trusted root fails 1, dedupe removed fails 1.

## Self-hosting: `review` and `land` skills (2026-09-01)

The dogfood loop covered only the BUILDER role; the independent final review and the merge
sequence still lived outside the harness (in the cloud-session workflow that has been reviewing
and landing these PRs). Two new checked-in skills codify those roles so the whole cycle can run
through AgentRig itself:

- `review` — independent adversarial review of one PR on its final head: isolated worktree merged
  with current main, green trio judged by real exit codes, the whole diff read against the repo
  invariants, test-quality checks, 2–4 mutation probes on the load-bearing lines (serial, never
  overlapping runs in one worktree), re-verification of at least one of the PR body's fail-first
  claims, CI checked on the actual head SHA. Verdict is findings (file:line, severity, scenario,
  fix) or an evidence-listing pass. Hard boundary: never merges, never pushes to the PR branch.
  Meant to run in a session that shares no context with the author run.
- `land` — execution of a human merge decision, never the decision: re-check every precondition
  now (human named this PR; review verdict resolved; CI green on the re-fetched current head,
  both platforms; mergeable), squash with a final-state body, then WATCH main CI on the merge
  commit and treat red main as an emergency. One flake re-run permitted under the same rule the
  drive-to-green flow uses. One merge at a time; open PRs with a moved base get flagged.

- `ship` — the conductor: one session that spawns a builder subagent (dogfood skill), then an
  independent reviewer subagent (review skill — subagent isolation makes the independence
  structural: the reviewer gets none of the builder's context by construction), then STOPS and
  presents the verdict. The human's next message is the only path to landing; a fix request
  spawns a scoped fix child plus one delta re-review. A ship run that ends waiting at the
  verdict is a success. A builder child dead at its budget is reported by session id for manual
  resume, not silently re-spawned — the rough child-resume story is the R4 session-trees row
  starting to matter.

The remaining role AgentRig cannot self-host is the escape hatch: when a bad merge breaks the
harness itself, the fix needs a tool that is not the broken tool.

## Dogfood skill: bounded review staleness (2026-09-01)

The first R1.5f dogfood run read §8's staleness rule as "full dual review after every fix
commit" and looped review→nit→fix→review for five rounds (~25–40 min each) without converging.
§8 now bounds it: staleness covers the delta only, fix-only commits are verified by their
fail-first tests rather than a fresh review round, at most one delta re-review, and a
non-converging reviewer gets its remaining findings recorded in the PR body instead of chased.
Also hardened the subagent abort test's tmpdir cleanup with rm retries — an aborted child still
flushing its JSONL raced the recursive delete on macOS CI (ENOTEMPTY, one observed flake).

## User-invocable skills: /skill-name — issue #62 (2026-09-01)

Status: **done**.

`/<skill-name> [task...]` in the TUI resolves an unclaimed slash-word against the loaded catalogue
and submits the skill body plus the trailing args as the turn, through the same submit path as any
task. The body rides inside `BEGIN/END SKILL` banners naming it repository-authored (the R13d
principal model: user invocation does not promote project-trust content), mirroring the
project-instructions banner convention. Built-ins always win by construction — `parseCommand`'s
switch claims its names first and only the default falls through to skill resolution —
`RESERVED_COMMAND_NAMES` exists so `/skills` can mark shadowed skills, with a guard test pinning
that every reserved name parses to its built-in. An unmatched `/word` keeps the old typo
protection: unknown-command treatment with a bounded-Levenshtein did-you-mean over built-ins ∪
skill names, and no model turn spent. `/skills` lists the catalogue (empty-state message, shadow
markers, a marker for space-containing names that cannot be slash-invoked).

New core event `skill.used {name, invokedBy: "model"|"user"}` — the issue said "existing" but no
such event existed; model-side activation was only visible as a generic `tool.call`. The `skill`
tool now emits it on successful loads only (a typo'd lookup is not an activation), and the event
is added to `TOOL_EMITTABLE_EVENTS` with `skill` as its sole emitter in `TOOL_EMIT_SOURCES` —
the first consumer of #67's source axis beyond the original three. `invokedBy: "user"` is
schema-valid but emitted by no core path yet: the CLI cannot (by design) append events to the
session log, so a TUI invocation's record is the delimited block in the user turn itself; the
enum value is reserved for a core-side invocation seam, and R9's user-vs-model comparison reads
the turn text until then. `buildAgent` now returns the discovered catalogue so the TUI can serve
it.

## Source-scoped emit gate — issue #67 (2026-09-01)

Status: **done** for findings 1 and 2; finding 3 (detector-side `file.changed` laundering) is
tracked separately — it needs detector changes, not a tighter emit gate.

The #63 gate was type-scoped: any tool could emit any of the four allowed kinds. Two of those
kinds carry authority beyond information, so `emitFromTool` now checks a third axis, SOURCE,
between TYPE and SHAPE: `TOOL_EMIT_SOURCES` in `events.ts` maps `plan.updated` to `update_plan`
and `subagent.spawn`/`subagent.end` to `subagent`; an emit of a mapped type from any other tool is
dropped and reported (`the "<tool>" tool tried to emit a "<type>" event, which only the "<sole>"
tool may emit; dropped` — all rejections now name the emitting tool). The bound name is the
REGISTERED tool's (`tool.name` from the loop's own lookup, the same identity `tool.call` records),
never anything the payload claims. `file.changed` deliberately stays open to every tool.

Why it matters: `emit` clears the supervisor's `force_replan` gate on any `plan.updated`, and the
forged plan also rewrites the scope the drift detector enforces — so under the old gate any tool
could release the one intervention PLAN §4.2 promises "cannot be ignored". The regression test
stages exactly that attack (gate raised mid-execution, tool forges `plan.updated`) and pins that
the gate survives; the constraint direction pins that `update_plan`'s own emit still lands and
still releases the gate. Both were verified fail-first against the gate with the SOURCE axis
removed. Decisions: the map lives in `events.ts` as plain strings rather than importing the tool
name constants (no events→tools dependency; a mapping change is a deliberate, visible edit guarded
by a drift test); an in-process tool that registers under a sole-emitter's name inherits its emit
right knowingly — tool registration is config-level trust, and the MCP adapter never calls
`ctx.emit` at all.

## Tool emit allow-list — issue #63 (2026-09-01)

Status: **done**.

`emitFromTool` in `agent.ts` now gates a tool's `ctx.emit` to `TOOL_EMITTABLE_EVENTS` (in
`events.ts`): `plan.updated`, `file.changed`, `subagent.spawn`, `subagent.end` — the four
informational/state kinds tools legitimately produce (inventoried across update-plan, edit-file,
write-file, subagent; the subagent deliberately does not forward child events). Anything else — a
forged `permission.decision`, `session.end`, or supervisor record — is dropped and reported as a
non-fatal `error`, mirroring `record()`'s validation of supervisor writes. Together the two seams
make the `record()` comment's guarantee ("an observer cannot forge a `tool.call` or a
`session.end`") actually hold. Grants no capability either way — the permission engine adjudicates
from the request, not the log — but the log is what the supervisor fold, `sessions show`, export,
and evidence read as truth, so a forgeable audit trail was its own harm. The set is a hand-kept
string list, not derived from the schema, so a new event type is not tool-emittable until someone
adds it deliberately. R13e fixture #2 was strengthened from "the forgery is ineffective" to "the
forgery is rejected AND ineffective". Pinned by `packages/core/test/tool-emit-allowlist.test.ts`
(both directions + reporting + a drift guard on the set), each verified fail-first against the
reverted gate.

## R13e injection fixtures (2026-09-01)

Status: **done** (pulled early per the roadmap's "rows, not milestones" note — pure tests, no
feature dependency on R13a–d).

`packages/core/test/injection-fixtures.test.ts` pins the R13 capability invariants that already
hold structurally, so a future R13a–d change cannot silently regress them:

- an injected instruction in a tool result cannot authorize a first exec call (headless ask→deny
  stands; the `run` call is `tool.denied`, never executed);
- a forged `permission.decision: allow` emitted into the log does not make the real engine skip a
  later call — the forgery is the adversarial setup, the still-denied exec is the pinned
  non-behavior;
- the permission engine decides from a `PermissionRequest` with no field for conversation, memory,
  or tool output — identical class+paths yield identical verdicts whatever the injected payload;
- a `pre_tool` hook cannot inject or fabricate an `allow` (the action is not in pre_tool's
  allow-list — rejected and reported);
- a forged supervisor audit record is rejected by the validated `record()` seam;
- a poisoned subagent brief inherits no widened permissions — the child runs under its own policy.

Each was mutation-verified: flipping the `RulePolicy` fallback to `allow` breaks four of them, and
dropping `record()`'s validation breaks the audit one.

**Finding surfaced, filed separately (not fixed here — out of R13e's pure-test scope):** a tool's
`ctx.emit` (`emitFromTool` in `agent.ts`) is unfiltered, so a tool can append a forged
`permission.decision` or `session.end` to the append-only log. It grants no capability (the real
engine still adjudicates every call — fixture #2 pins exactly that), but it contradicts the
`record()` comment's stated guarantee that "an observer cannot forge a tool.call or session.end."
An allow-list on `emitFromTool` is the fix, tracked as its own issue.

## Roadmap third pass (2026-09-01)

Two unified analyses of the `system_prompts_leaks` prompt-capture corpus were folded into
`docs/ROADMAP.md`: a new "third corpus" section (with per-capture confidence tiers and CC0
reuse caveats), new rows R1.5f, R5e, R6d–R6g, R12e, R13d–R13e, R14d, an amended R1.5d
(prompt bill of materials + freshness markers), and renunciations №10–12 (no prompt-compiler
subsystem, no mode state machine, no verbatim reuse of captured prompt text). Rows, not
milestones — the sequencing diagram is unchanged.

## CLI: leading --profile (issue #56)

Status: **done**.

- `--profile` is now also a root-level option, so the alias shape `agentrig --profile personal
  <subcommand>` dispatches correctly instead of dying in the default TUI command's stray-operand
  check with "unknown command 'sessions' (Did you mean sessions?)".
- Deliberately the ONLY dual-registered flag: Commander scans root options out of argv wherever
  they appear (the shipped root-option regression documented in `program.ts`), so the root copy
  swallows the subcommand's `--profile` token — the value is recovered at the config seam via
  `optsWithGlobals()` (`configured` and the doctor action). A test pins that the root option set
  is exactly `["--profile"]` so no other flag quietly migrates up.
- Behavior note: subcommands that never consult config (`sessions ls`, `login`, `dream`,
  `memory ingest`, …) accept `--profile` in ANY position (the root scan reaches trailing flags
  too) where they previously errored "unknown option". Never silently: a preAction hook prints
  `note: --profile is ignored by \`<command>\`` — erroring instead would break the alias shape
  this exists for, since a wrapper function appends the flag to every forwarded subcommand.
- Known accepted cost (adversarial review): a literal `"--profile"` used as another option's
  VALUE (`--system "--profile"`) is stolen by the root scan and errors misleadingly. The escape
  hatches work and are documented in `program.ts`: the `=` form (`--system=--profile`) and
  anything after `--` are never scanned. `enablePositionalOptions()` would remove the class but
  forbids the pinned bare-launch shape `agentrig --yolo`.
- Pinned by dispatch, both-positions value flow, run/TUI/doctor end-to-end profile resolution,
  nested `sessions resume` recovery (a `cmd.parent?.opts()` mutant survived the original suite),
  the ignored-note behavior, and root-option confinement tests; each verified to fail with the
  corresponding code reverted.

## Supervisor refinement

Status: **done**.

- Background polling now composes with the loop detector's durable-progress reset: a `bash_job`
  status result carrying incremental output clears repetition, and a poll with positive `waitMs`
  that comes back empty is NEUTRAL — not spinning, but not progress that clears other tallies
  either (clearing there let a `waitMs` poll on a finished job, which returns immediately, launder
  an unrelated loop running between polls). Immediate repeated polls that report `(no new output)`
  still tally, as do identical non-poll calls. Pinned by `treats identical bash_job status polls
  carrying new output as progress`, `does not count deliberate bash_job status polls that use
  waitMs as spinning`, `a waitMs poll between identical failing commands does not launder the
  loop`, `still counts repeated non-blocking bash_job polls with no new output`, and the
  pre-existing `loop: the same call three times with nothing changing is still a loop`. The
  `(no new output)` literal is pinned core-side too, as a cross-package contract.
- Verification/shipping is observable progress when a bash exit code transitions in either direction
  or a successful command stages, commits, pushes, or performs a `gh pr` operation. Variation credit
  is withdrawn when that varied call fails, preserving PR #36's varied-input lesson without allowing
  failure alternation to escape. Pinned by `treats bash exit-code transitions in either direction as
  verification progress`, `treats repeated successful git push operations as shipping progress`, and
  `does not forgive an A/B loop of fifteen failing bash commands on variation alone`.
- Escalation handlers may now resolve `answered`, `expired`, or `closed`; TUI prompts return that
  outcome, while legacy/non-TUI void handlers default to closed. An expiry counts as the issued
  rung's outcome and suppresses another ask only for the same stable signal signature for the rest
  of that policy/session, degrading it to guidance. Pinned by `degrades an expired escalation
  signature to guidance for the rest of the session`, `still escalates a different signature after
  another escalation expired`, `an answered escalation suppresses nothing`, `an expired escalation
  is counted once and recurring signals degrade to guidance`, `a void non-TUI escalation handler
  defaults to closed and suppresses nothing`, and — through the real timeout path rather than an
  explicit return — `a timed-out escalation counts as expired and degrades the recurring
  signature`.
- Rejected idea: exempt every `bash_job` status call from loop detection. It would hide the R1e shape
  where immediate polls repeatedly return no output; result-aware handling preserves that evidence.
- This refinement session's exact token count is unavailable from the API runner rather than
  fabricated; record it as another unavailable point beside the **1,718,936 / 669,418 / 3.3M /
  4.0M** existing baselines.

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
  resumes; `maxMinutes` is per-run wall clock. Resuming a budget-ended session requires an
  effective budget above the exhausted count; that can come from config/an explicit override or
  from resuming through an entry mode whose default is higher.

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
- **The browser sign-in works (verified live, 2026-08-30, macOS, no Codex credential present).**
  First attempt, first try: the authorize parameters read from the codex source are right, and the
  loopback redirect, state check and code exchange all behaved. Nothing in the auth path is
  unverified any more.
- **`login` exits when it is done, which is correct and was unhelpful.** It is a separate command
  from `run`/`tui`, like `gh auth login` — but the only "what now" it printed was `--export`, for
  seeding a cloud environment. It now names the two commands a person actually wants next, both
  with `--model`, since this provider requires one and a hint that does not run is not a hint.
- **`loginCommand` has tests** (it had none): the auth object is injected, so everything except the
  one human-and-browser step is covered — the unknown provider, the URL being printed before the
  wait, `--no-browser`, the next-step hint, a failed sign-in exiting non-zero, and `--export`
  keeping the credential on stdout alone.
- **Sign-in is a browser flow now; the device-code flow is deleted (F1, 2026-08-30).**
  `auth.openai.com` puts an interactive Cloudflare challenge in front of BOTH `/deviceauth/usercode`
  and `/oauth/authorize` (`cf-mitigated: challenge`, 403 — reproduced from a cloud container and
  from a desktop, and confirmed again against `/oauth/authorize` while building this). The
  challenge targets the HTTP *client*: `fetch` is not a browser wherever it runs, so no Node
  process can complete either. An earlier note here said to "sign in on a machine with a browser";
  that was wrong.
  `startLoopbackLogin` inverts it — **the browser makes the challenged request and we never do**:
  - PKCE S256; the verifier never leaves the process, the challenge goes in the URL.
  - A one-shot listener on `127.0.0.1` **and** `::1`, because the browser decides what `localhost`
    means and on Windows that is usually `::1` — a v4-only listener never hears the redirect.
  - `state` is checked before anything is exchanged: a redirect that fails it is not ours, and a
    code we did not ask for is never sent to the token endpoint.
  - The code is never echoed into the page the browser shows. Paths other than the callback get a
    404 rather than failing the login, because a browser also asks for `/favicon.ico`.
  - The code is exchanged at `/oauth/token` — the same endpoint every refresh already uses, and the
    one endpoint that is NOT challenged, which is what makes the whole flow possible.
  - The device-code code and its tests are deleted rather than kept: a path proven unusable in
    production, kept "just in case", is dead code that reads like a fallback.
  Seeding from Codex's `~/.codex/auth.json` still works and is still the fastest path on a machine
  that already has it.
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
  dead rung. In the TUI the handler is now a free-form prompt rather than a line printed into
  scrollback: the answer is queued back to the running agent as a user steer. The prompt expires
  and is also settled on session/UI teardown, so a user who never answers cannot hang the run.
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
- **`stall` treats exploration as progress, not just a new tool name.** A turn that reads a file or
  searches/globs a path not seen before resets the quiet-turn tally, so an agent orienting itself
  through an unfamiliar tree is not called stuck; repeatedly reading the same target still fires.
  One continuous stall condition now emits once and re-arms only after progress, instead of
  generating the same escalation every N turns and climbing the ladder on unchanged evidence. Its
  test-run branch has the same one-signal-per-unchanged-count behaviour, counts only runs that are
  **still failing**, and resets whenever a file changes: an unchanged pass count on a *green* suite
  is the success condition, and re-verifying that a refactor kept the suite green is exactly the
  shape this would otherwise have called a stall.
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

## Standing permission answers (from the first task worth approving, 2026-08-30)

- **Approving every action individually is how a prompt stops being read.** A task that edits
  twenty files raised twenty identical prompts, and the only alternatives were `--allow write
  --allow exec` at startup (all-or-nothing, decided before you know what the task will do) or
  answering all twenty. Both are worse than a prompt that remembers.
- `a` at a prompt allows that **tool** for the rest of the session; `d` denies it for the rest of
  the session, which is how a tool that is misbehaving gets shut off without aborting the task.
  `y`/`n` still answer once.
- **Per tool, not per class or per call.** A class ("allow all writes") grants more than the
  prompt was showing; a per-call grant remembers nothing. The tool name is what the prompt named.
- **In memory only, never written to disk.** A blanket grant that survives the process outlives
  the task it was made for, and nobody remembers making it. `/permissions` lists what is standing
  and `/permissions reset` clears it.
- Caveat: a standing answer applies to a subagent's requests too, since they carry the same tool
  name (with `origin: "subagent"` shown on the prompt). Granting `bash` for the session grants it
  to children as well.

## The TUI held no conversation (from the second interactive run, 2026-08-30)

- **Every prompt started a new session.** `submit` called `agent.run(task)` with no `resume`, so
  nothing the user said was ever in scope for what they said next — three exchanges in a row
  reported `turn 1` and sent 1330, 1335, 1330 input tokens, an input that never grew because no
  history was being sent. A task now continues the current session, and `/new` drops the thread
  deliberately. A session is only continued once a `turn.end` has been seen, because that is when
  the loop writes the snapshot a resume reads: a session that died before finishing a turn (a
  provider rejecting the request, as the live `400` did) has nothing to resume from, and asking
  would lose the next prompt to an error.
- **A bare `exit` was sent to the model.** It spent a turn and 1330 tokens replying "Exiting." and
  then did not exit. `exit`, `quit`, `bye` and `:q` on their own are now the quit command, as in
  every other REPL; inside a sentence they are still ordinary words.

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

## The first dogfood run, and what it found (2026-08-30)

PLAN §6's exit criterion — "the harness is used to build the next milestone" — was honoured for
the first time: agentrig implemented the caller-declared drift scope, on the drift detector, using
itself. It read the detector, the CLI wiring and the existing tests, made the change, hit a real
cross-package typecheck failure and fixed it correctly by rebuilding the supervisor's declarations
first, then committed and pushed on request.

The review of that work found the change sound — and found two things the work could not have
known about:

- **`--drift-scope` was proven to parse, not to arrive.** Deleting the line that passes it into
  `supervise()` broke no test, because the wiring was inline in `runCommand` and the only way to
  exercise it was to run a whole session. `supervisorOptions()` is now exported and pure, the same
  shape as `subagentOptions()`, and the mutation that drops the flag fails a test.
- **`--supervise` did nothing in the TUI, and never had.** `runCommand` calls `supervise(session)`;
  `startTui` never did. Every detector, the whole ladder, the reviewer and the grader were
  unreachable from the default entry point, while the flags were accepted and validated. The
  dogfood session ran 33 turns with `--supervise` and produced no signal — which was read as
  "the thresholds are conservative" until the code said otherwise. `TuiOptions` did not even
  include the supervisor flags: the type was the first evidence.
  The TUI creates its sessions inside the controller, so nothing outside could attach an observer;
  `TuiControllerOptions.onSession` is that seam, called before the events are consumed — an
  observer attached late has missed the events it exists to judge. An observer that throws costs
  its own attachment and not the session.

The lesson is the one the whole exercise was for: **a flag that is parsed, validated and
documented can still be connected to nothing**, and no amount of unit testing at either end finds
it. Only running the thing did.

## The supervisor, watched doing real work (2026-08-30)

The second dogfood run — the contract watchlist, built by agentrig with `--supervise` actually
attached for the first time. Every rung fired, and each one is now observed rather than inferred:

- **`stall` → `inject_guidance` → the agent changed course.** The steer was delivered and answered
  ("I'm not blocked; I was tracing the shared run/TUI option path"), and file edits started on the
  next turn. Signal to behaviour change, live.
- **`force_replan` blocked a tool call**: `blocked: the supervisor requires a fresh plan before
  more tool calls`. The agent called `update_plan` and continued. The M6 rung works.
- **`error_burst`** fired at 5-of-10 failing calls; **`escalate`** reached the user through the
  TUI's new `onEscalate`.

Three defects the same run exposed, none of which a test would have found:

- **`stall` fires on reading.** Its first signal landed during legitimate orientation — several
  turns of `read_file`/`grep` while mapping unfamiliar code. "No file changed and no new tool
  used" describes research as well as it describes being stuck, and the agent's reply amounted to
  "I am not stalled, I am reading". It was right.
- **`escalate` asks a question nobody can answer.** The TUI prints it and moves on; there is no way
  to reply, and nothing waits for one. A rung whose purpose is to consult a human currently
  consults and ignores.
- **The same signal repeats.** Identical stall escalations at 38, 41 and 58 tool calls on an
  unchanged condition. A ladder that re-fires one rung is noise, and noise is how a supervisor
  comes to be ignored.

## A default that was load-bearing and untested

`--drift-contract` defaults to `undefined`, not `[]` — deliberately. An absent flag must leave
`DriftOptions.contract` unset so the detector's own `DEFAULT_CONTRACT` applies; passing `[]` would
reach it as "watch nothing" and switch the whole feature off for every run that did not name a
path. Changing `undefined` to `[]`, which is the obvious edit for consistency with
`--drift-scope`, broke no test when the feature was written. Both halves of the property are
pinned now: the flag's default, and the detector's fallback.

## "Green" meant Linux (from the first macOS run, 2026-08-30)

Two tests failed on a Mac. Neither was a code defect; both were **Linux assumptions in the test
scaffolding**, written by someone who only ever ran the suite on Linux and reported it green.

- **`mcp-process.test.ts` read `/proc/<pid>/stat`.** macOS has no `/proc`, so its liveness helper
  returned "gone" for every pid: the pre-condition ("the grandchild is running") failed, and the
  post-condition ("it is gone after close()") passed **for the wrong reason**. A test that cannot
  pass on a platform is bad; one that also passes vacuously there is worse. It now falls back to
  `kill(pid, 0)`, which cannot see a zombie — hence the existing poll.
- **The shell test compared `/bin/bash` against `/bin/sh`.** That only demonstrates anything where
  `/bin/sh` is dash. On macOS it is bash in POSIX mode and runs `[[ ]]` happily, so the assertion
  failed for a reason unrelated to the code. Replaced with a **stub shell script** the test writes
  itself, asserting the command arrives as `-c <command>` — deterministic on every platform, and
  a stronger claim than the original.
- **`groupIdOf` also read `/proc`,** so every assertion guarded by `if (group !== null)` was
  skipped on macOS — passing without testing. It falls back to `ps -o pgid=`.
- **CI now runs the matrix** (`ubuntu-latest`, `macos-latest`) on push and PR. There was no CI at
  all before this: every "green" in this repo's history was one person running one platform.
  Windows is follow-up **F3** — the suite's POSIX assumptions would make that job red on arrival,
  and skipping the failures to get it green would produce a job that tests nothing.

## Windows notes (from the first real desktop run, 2026-08-30)

- **CRLF was a silent edit-breaker.** `read_file` and `grep` split on `\n` only, so on a CRLF
  checkout — every clone on Windows — each line reached the model with a trailing carriage return
  (`"1\t# AgentRig\r"` in a live trajectory). The model then copies what it was shown into
  `edit_file`'s `oldText` with plain `\n`, which matches nothing in the file, and *every*
  multi-line edit fails with "oldText not found". Both tools now split on `/\r?\n/`, and
  `edit_file` retries a failed match with the line endings converted — in both directions —
  converting `newText` the same way so the file keeps the endings it had. An edit must not
  rewrite every line of a file as a side effect of matching one.
- **The `bash` tool ran `cmd.exe` on Windows (fixed — F2).** `spawn(..., { shell: true })` means
  `/bin/sh` on POSIX and `cmd.exe` on Windows, and a model writes bash — so on Windows every
  command went to a shell that does not speak it, and the model was never told which one it had.
  `resolveShell` now picks it and `--shell` overrides it:
  - **POSIX keeps `/bin/sh`.** Changing it would silently change what every existing trajectory in
    every repo means. `--shell /bin/bash` is there for anyone who wants bashisms — and `[[ ]]`
    really does fail under `/bin/sh` (dash), which is the same class of bug as `cmd.exe`, milder.
  - **Windows prefers Git Bash, then PowerShell, then `cmd.exe`** — the first speaks what the model
    writes, the second is at least a real shell, the third is the status quo.
  - **The description names the shell and the syntax**: "using bash.exe … Write POSIX shell
    syntax", or "using cmd.exe … Write cmd.exe syntax (`dir`, not `ls`; `%VAR%`, not `$VAR`)".
    Half the fix is picking a shell; the other half is telling the model which one it got.
  - The tool is still called `bash`. Permission rules and every trajectory ever recorded name it,
    and renaming it would break both to fix a label.
  - `--shell` is validated once at build time — a path that does not exist is refused by name,
    rather than failing on every command with an ENOENT that names neither the flag nor the file.
  - Caveat: `resolveShell` takes the platform as a parameter, so it must not use `node:path`'s
    `basename`/`sep`, which follow the *host*. It parses both separators itself; the first version
    did not and mis-classified every Windows path when run from POSIX.
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

## --yolo / --dangerously-skip-permissions (2026-08-30)

Asked for after a dogfood run in which the agent's first move, `git fetch origin main`, was denied
twice — standing answers (`a`) help once you are asked, but not before the first prompt of every
kind, and not at all unattended.

Implemented as the RulePolicy **fallback**, not as a switch that bypasses the policy:

```
[ ...--deny, ...--allow, ...memory tools, ...defaultRules ]   fallback: skip ? allow : ask
```

Order is the whole design. `--deny` is matched first, so it still wins under `--yolo`: skipping the
prompt is not the same as discarding a rule you asked for, and `--yolo --deny bash` has to mean
something. Skipping changes only what happens to a request nothing matched — `ask` normally,
`allow` here — so it can never overturn an earlier decision.

Notes for a future reader:

- **Two spellings, one meaning.** `--dangerously-skip-permissions` says what it does, `--yolo` is
  what people type. Both are read through `skipsPermissions()` rather than checked individually, so
  a caller cannot honour one and miss the other — a mutation that drops the alias fails five tests.
- **The warning names the working directory.** "Permissions are off" is abstract; "it may delete
  anything outside /Users/you/project" is not. It also lists any `--deny` still in force, or the
  warning would be actively misleading.
- **It stays auditable.** `permission.request` and `permission.decision` are emitted for every call
  regardless of how it was decided, so a run that asked nothing still reads back completely in
  `agentrig sessions show`. That was already true; it is what makes the flag defensible.
- **Subagents inherit it**, because parent and children share one policy object — a child that
  could do more than its parent would be a permission bypass with extra steps, and the same
  reasoning makes a child that must ask when its parent need not merely annoying.
- **No root check.** Refusing to run as root is a common guard, but every container runs as root
  and that would break the main unattended use case. The warning is the guard.

## A multi-line paste sent only its first line (2026-08-30)

Found the first time a multi-line brief was pasted into a TUI where pasting finally worked. The
handler submitted at the first newline and joined the remainder with spaces:

```
Fix three defects in the supervisor that a live dogfood run exposed.
BRANCH FIRST. Run `git fetch origin main` then ...
a turn is already running — /abort first
(1) packages/supervisor/src/detectors/stall.ts fires on legitimate reading. ...
a turn is already running — /abort first
```

The agent got one sentence as its whole task and set about searching memory and grepping the tree
to work out what the three defects were. Every following line arrived while that turn was running
and was refused.

The rule was written when an embedded newline could land in the buffer literally and corrupt a
line, and submitting at the first one was the cautious reading. It is the wrong one: a newline
*inside* a chunk is pasted text, and enter arrives as a chunk of its own — which is how every
other terminal UI tells them apart. A paste is now kept whole, line breaks and all, and enter
submits it. `\r\n` is normalised to `\n` on the way in.

This only became reachable once pasting worked at all, which is why five rounds of paste fixes
preceded it: the freeze, the frame height twice, the pty deadlock, and then this. Worth noting for
the next time a fix "completes" a feature — the bug behind it may simply never have been reachable
before.

## The paste freeze was a pty deadlock, and neither earlier fix touched it (2026-08-30)

Two merged fixes later the TUI still froze on a paste in cmux on macOS, with ctrl-c dead. A probe
that renders the real component in a real terminal and traces every stdin read and stdout write
synchronously (`packages/cli/scripts/frame-probe.mjs`) settled it. At 158x52:

```
+22939ms read#1  len=64    total=64
+22940ms write#5 len=144   total=13589
+22940ms read#2  len=1016  total=1080
+22949ms write#6 len=1166  total=14755
                      <- nothing, ever
```

`%CPU 0.0`, `STAT S+`, and the 500ms heartbeat stops dead after `write#6` is logged — and that log
line is appended *before* the write is forwarded. So the process is asleep inside a 1,166-byte
blocking write to the tty, with 1,080 of ~2,242 pasted bytes delivered and the rest never arriving.

Node's writes to a TTY are synchronous on macOS. The peer was blocked writing the rest of the paste
into the pty's input buffer — because this process had stopped reading in order to service a
render — while this process was blocked writing its output, because the peer was not draining that
side. Both sleep forever. Ctrl-c does not help: in raw mode ctrl-c is a byte on that same stalled
stdin, not a signal.

**Total output involved: 1,310 bytes, and zero full-screen clears.** The frame height was never the
cause of this one. The two earlier fixes were real — the byte counts behind them stand, and a
frame taller than the window genuinely costs a full repaint of the whole scrollback per render —
but they were fixing a different problem, and no amount of shrinking a frame avoids a deadlock that
needs about a kilobyte to trigger. Nor could any fake-TTY test have caught it: the harness has no
pty, and a fake stdout never blocks.

The fix is `packages/cli/src/tui/input-buffer.ts`: the buffer is the truth and moves synchronously,
and drawing waits for stdin to go quiet (32ms). A 31-chunk paste now draws once, at the end, and
writes nothing while the terminal is still pushing input. Submitting a line still draws
immediately, because the prompt has to clear before the reply starts.

Notes for a future reader:

- **There is deliberately no maximum wait on the coalescing.** A ceiling would guarantee a write in
  the middle of a long enough paste, which is exactly the thing being avoided. Input that never
  pauses is input nobody is reading yet.
- **The first version of this fix blinded the TUI completely.** The edit that introduced
  `InputBuffer` spliced out `useEffect(() => controller.subscribe(setState), [controller])` along
  with the code it was replacing. The App kept accepting input and the agent kept running — the
  session log showed the model planning and reaching a permission prompt — but nothing the
  controller printed ever reached the screen: no echo of the task, no status change, no permission
  prompt, no streamed reply. Pressing enter looked like it did nothing at all.

  Every existing test of this component passed. All of them count bytes — how many writes, how
  large, whether a full-screen clear appears — and a component that renders a frame nobody has
  told anything to still writes frames. `test/tui-visible.test.ts` asserts on CONTENT instead:
  that a printed line, a permission prompt and the session id actually appear in what reaches
  stdout. Removing the subscription fails all three and none of the twelve byte-counting ones.
- **The first version of it still wrote mid-paste, on the most ordinary paste shape there is.**
  Submitting drew synchronously, on the reasoning that stdin had just gone quiet. It has not: a
  newline *inside* a paste submits from the middle of an arriving burst, and a bare carriage
  return can be drained in the same batch as the text ahead of it. One newline in a 120-chunk
  paste produced 11 writes and 1,141 bytes with chunks still queued — the byte volume of the write
  that deadlocked. Both submit paths now queue their work to the same quiet point, after the draw.
- **The claim holds only at an idle prompt.** Pasting while a reply streams — queueing a follow-up,
  entirely routine — still writes, because the output is not the paste's to control. That is
  inherent to an async stream rather than a hole in this fix, but it is not "nothing is written
  while a paste is arriving" either.
- **Keystrokes must not push the deadline out.** Resetting the timer on every change starved input
  arriving faster than the window: measured at 15ms and 25ms and 30ms intervals, zero draws for as
  long as the input continued. Human typing is nowhere near that, but macOS key auto-repeat is
  15ms at the fast end of the slider — holding backspace froze the prompt until the key was
  released. A change of four characters or fewer now leaves the existing deadline alone.
- **Confirmed on the machine that had the bug.** The same ~2,500-character paste that froze cmux
  three times now lands, drawn as its tail with a `…(1,142 more)` marker, and submits in full.
- **This is a mitigation for an environment bug, not a repair of one.** A terminal that drains its
  output side while writing input does not deadlock. What agentrig controls is whether it writes at
  all mid-paste, so that is what changed. It has not been reproduced in a test, and cannot be
  without a real pty and a peer that stops reading; the end-to-end test asserts the property that
  closes the window (no writes until the chunks stop), not the deadlock itself.
- **Three wrong diagnoses preceded this one**, each plausible and each measured: bracketed paste
  (ruled out — the first 24 bytes were plain text), frame height (real, fixed, not this), and a
  stalled Node stream (ruled out by the heartbeat: `readableLength=0`, `isPaused=true` — nothing
  was waiting to be read, the reader was simply never going to run again).
- **The probe is kept.** It is the only instrument that can see any of this, and a sampling version
  of it saw nothing at all — a timer never fires on a blocked loop, which is why the first version
  logged one line and stopped.

## The paste fix was half a fix — the review found the other half (2026-08-30)

The adversarial review of the fix above found three majors. All three are now fixed; the section
above describes the mechanism, this one what it got wrong.

**The budget counted characters, and a reply is mostly line breaks.** `fitToRows` multiplied
columns by rows and compared that to `text.length`, which is the same quantity only for text with
no line breaks in it. An answer made of bullets and code — the shape almost every real reply has —
measures far more rows than characters/columns suggests. A **1,625-character** reply of short
lines measures 155 rows, drove 40 full-screen repaints and 699,389 bytes; flattening the same text
to one line: 0 repaints, 31,059 bytes. So the freeze was unfixed on the more common of the two
paths, and the one test covering it streamed `"answer ".repeat(500)` — a single long line with no
newline in it, the one reply shape a character budget happens to handle. The budget is now rendered
rows (`measureRows`), measured in display columns via `string-width` — the same measure Ink uses —
so wide characters count as two.

**`liveRows` budgeted one growable region and the frame draws two.** With a reply streaming *and*
something typed, the frame is `2 × liveRows + 3`. Every terminal from 12 to 20 rows — a tmux pane,
a split editor, VS Code's integrated terminal at its default height — still froze exactly as
before. The allowance is now halved (`(rows - 6) / 2`), and the test asserts the condition the
frame actually has to satisfy rather than restating the furniture count.

**The regression guard could not fail on CI, which is the only place it runs.** Ink checks
`is-in-ci` *before* the frame-height branch in `onRender` and returns having written only the
`<Static>` output. GitHub Actions sets `CI=true` on every step. Reverting the fix entirely and
running `CI=true pnpm test` left all four frame tests green. `test/setup-no-ci.ts` now clears those
variables before any test file imports Ink — a setup file, because `is-in-ci` computes its value at
module load and `vi.stubEnv` inside a test is too late — and one test asserts the setup ran, so the
guard is itself guarded.

Two pre-existing bugs surfaced in the same pass, both confirmed identical on the commit before any
of this work and both fixed here:

- **The TUI went silent for good at the 5,000th line.** `print` did `lines.slice(-maxLines)`, but
  Ink's `<Static>` remembers how many items it has written and renders `items.slice(thatIndex)`.
  Dropping items off the front shifts every index past what it remembers, and nothing is ever
  printed again — no error, no clue. The array is now append-only; the cap releases the *text* of
  a line that falls out of the window, which `Static` never reads again, so memory is still bound.
- **A paste ending in a newline lost a chunk.** Ink drains several stdin chunks in one `readable`
  batch and React does not update state between them, so the submit paths that read the `input`
  state variable saw a stale buffer: pasting 2,500 characters ending in `\n` submitted 2,436.
  The buffer is now a ref, which moves synchronously; `input` exists only to trigger a re-render.

Smaller things from the same review: the "(N more)" count under-reported by the marker's own width
(now derived from what was actually kept); the marker could be returned wider than a one-row
budget in a very narrow window; and `columns ?? 80` let a TTY-reported **zero** through, collapsing
the budget to one character per row so the user saw the marker and none of what they had typed —
Ink's own layout uses `||` for exactly this reason.

## The TUI froze on a pasted brief (2026-08-30)

Pasting a ~2,500-character task into the TUI hung it, twice, on a terminal that was otherwise
responsive. It is not the paste handling: it is how tall the frame is.

Ink has a cliff in its renderer. While the live frame is shorter than the window it redraws
incrementally through `log-update`. The moment `outputHeight >= stdout.rows` it gives up on that
and writes `clearTerminal + fullStaticOutput + output` instead — a full-screen clear followed by
the **entire** accumulated `<Static>` scrollback, which Ink appends to and never trims. So a tall
frame does not cost one big paint. It costs one big paint per render, and the paint grows with how
long the session has been running.

Two things in the frame grow without bound and are drawn live: the input buffer and the reply as
it streams. A 2,500-character line wraps to ~32 rows at 80 columns, which is taller than most
windows; a paste arrives at a raw-mode tty as a run of chunks, and each chunk is one `useInput`
call, one `setInput`, one render.

Measured with the real `App` against a fake 80x30 TTY, a 2,500-character paste in 64-byte chunks:

| scrollback | before | after |
| --- | --- | --- |
| 300 lines | 40 repaints, 192,596 bytes | no full-screen repaints, ~27,000 bytes |
| 2,000 lines | 40 repaints, 962,196 bytes | unchanged from the 300-line case |

An 80-character paste cost 267 bytes either way — the blow-up is entirely the cliff.

The fix is `packages/cli/src/tui/viewport.ts`: `fitToRows` draws the tail of a growable region and
says how much it is not showing, `liveRows` decides how many rows one region may claim (a small
fraction of the window, since the prompt, the status line and a permission prompt share the frame
and the cliff is a property of the frame as a whole). Nothing is truncated in the buffer — it is a
viewport, not an edit; the full text is still what gets submitted.

Notes for a future reader:

- **The streaming reply was the worse half.** A pasted brief is unusual; a multi-thousand-character
  answer is an ordinary reply, and it arrives token by token, so the tall frame was fully repainted
  once per delta for the whole turn. That is most of why the TUI felt slow before any of this was
  understood, and `--verbose` made it worse by growing the scrollback that each repaint reprints.
- **`app.tsx` is no longer untestable.** Its header used to say there was nothing in it worth
  testing. How tall it renders is a correctness property, so `packages/cli/test/tui-frame.test.ts`
  mounts the real component against a fake TTY and asserts on the bytes that reach stdout — the
  presence of a full-screen clear in a write *is* the pathology, so that is what it looks for.
- **`fitToRows` counts characters, not display columns.** A wide-character or emoji-heavy line can
  therefore wrap one row further than the budget assumed. `liveRows` leaves eight rows of headroom,
  which absorbs it; a `string-width` measure would be exact and is not worth the dependency yet.

## Next: the R-milestones (2026-08-30)

M0–M7 are done and merged. What comes next is `docs/ROADMAP.md`: fifteen R-milestones distilled
from studying six open harnesses (Codex CLI, pi, DeepSeek Harness, Hermes Agent, OpenClaw,
nanobot), ordered by dogfood leverage — context/config first, context economy (R1.5, added after the first --yolo dogfood run spent 3.3M input tokens on quadratic resends), sandbox, session
trees/checkpoints, then the compounding loop (extensions, memory→skills, scheduler), then the
serve/eval/parallel surface. The roadmap carries its own renunciation list (§4) so future
sessions don't build the gateway/web-UI/marketplace features the research argued against, and it
resolves both PLAN §8 open questions (R2 sandboxing, R4 checkpoints). A second, independent
research pass over a different corpus (OpenHands, SWE-agent, Aider, Gemini CLI, Cline, Goose,
OpenCode, the orchestration runtimes) was merged in afterwards: it validated the build order and
the memory-promotion gate from the other direction, hardened R1/R3/R5/R10 (trusted-project
boundary, doctor, side-effect-aware replay, tool-definition pinning, worktree-per-writer), and
contributed the closing trust-and-proof arc — R12 capability grants, R13 provenance labels, R14
acceptance contracts with claim→evidence grading.

## Decided

- Lore is an optional `MemoryBackend` behind the seam in PLAN.md §3.8; the wiki stays the source
  of truth and the default stays no-infra (milestone 3b).
- AgentLens is a future sink for the event stream (observability), not a memory dependency.

## Follow-ups (PLAN.md §9)

Recorded rather than built, each with a working path in the meantime:

1. ~~**F1 — PKCE + loopback login for `openai-chatgpt`.**~~ Built (2026-08-30) — see below.
2. ~~**F2 — a configurable shell for the `bash` tool.**~~ Built (2026-08-30) — see below.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Dogfood repo after AgentRig itself
