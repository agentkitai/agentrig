# Shipping: parallel verification, bounded repair

This is the shared review/repair policy for `dogfood`, `ship`, `topic`, `review`, and
`land`. Read it with the selected skill. It replaces their historical per-fix dual
review loops, not their authorization, isolation, testing, or merge gates. These
are model-facing instructions, not a runtime enforcement mechanism. No model or agent authorship identifiers belong in commits, PR titles/bodies, or code comments. The single PR-body and squash-body exception is a verbatim human authorization quote that itself contains such an identifier: preserve the quote unchanged, but never add model or agent authorship attribution.

## 1. CI and review are independent tracks

`<REPO>` is the absolute path to a separate clean checkout at the fetched base-branch commit,
NEVER the PR head. Prepare it using `topic` §2 step 4's **Adapter checkout boundary**: record
literal path, base SHA and preparation receipt; prepare required dist from that same base.
Load review/ship/topic/land/arbiter skills and run adapter, schema, posting and finding-index
helpers from this base-pinned tree, never copies from the PR under review. Keep reviewed source
and config in the separate PR-head reviewer tree. A tooling-changing PR is data, not its own
review authority. Never use the author tree or stale main dist. Retain the base tree until all
adapter jobs join and receipts are persisted. Empty checks authorize no undeclared build;
if required dist is unavailable, halt rather than run undeclared checks.


Builders and fixers run the local green declared checks, fail-first regressions, and meaningful
mutations before pushing. After opening/updating the PR, report its head and current
CI state immediately; do not wait for hosted CI or run private external reviews.
The conductor (or standalone dogfood author) first proves independent same-head declared checks green, then launches each declared reviewer
slot in a separate owned worktree while hosted CI runs. Record all declared review job IDs,
the reviewed SHA and CI run IDs; monitor these independent tracks together. Zero slots skip
external review only, recording `External review: none declared`.

Reviewers report pending CI as pending and return their code verdict without waiting
for CI. A code-review pass is not permission to merge. Only the lander joins the
gates: resolved reviews AND successful required checks on the actual current head.
Missing, pending, cancelled, stale, or failed checks never count as green. Local
test failures are not excused by a green hosted run. Follow docs/TESTING.md for
environment-limited checks, preserving environment evidence for conductor checks.

Freeze the author branch during a review batch. If it changes anyway, retain the
old review as evidence for its SHA, inspect OLD..NEW, and apply §3; do not discard
valid reviews and restart the whole pair solely because the head moved. An aborted
initial pass is incomplete: all declared initial reviews must finish before landing.

## 2. Disposition every finding once

Keep a `## Review disposition` ledger in the PR body: reviewer comment/finding ID,
severity, concrete scenario, blocking or non-blocking, rationale, resolution/evidence,
and affected SHA. Distinguish verified defects from optional suggestions. A concrete
proposed fix alone does not make a suggestion a merge blocker.

Persist `Repair round: N/3` in the PR body (initially 0/3), and each round's OLD/NEW,
assigned blocker IDs and outcome. Increment before spawning each repair batch, not
after it completes. Every entry point, including ship and standalone dogfood, reads
this record on resumption; reconstruct missing counts from recorded handoffs/reviews
with evidence, never silently reset them. If the count cannot be established, halt
with that missing evidence rather than grant a fresh allowance. The lander verifies
the record against the review history before merging.

- **Blocking:** unmet task acceptance, incorrect required behavior, security or
  authority regression, data loss, failing required checks, material missing proof,
  or unapproved contract/authorization changes. Severity does not excuse these:
  even a LOW acceptance failure blocks. All HIGH findings block. Uncertain impact
  stays blocking until evidence establishes otherwise. Contract deviations still
  go through the arbiter; do not silently weaken the task to close a finding.
- **Non-blocking defect:** a verified minor defect with evidence that it affects
  neither required behavior nor the safety/verification gates above. Preserve its
  severity and scenario; record why deferral is safe. File one `review-residual`
  issue per actual deferred defect and link it under `## Residuals` in the PR body.
  Include file:line, scenario, proposed fix, PR/head, and original review URL. Do not
  spend repair rounds merely to postpone creating that same issue.
- **Advisory:** preference, cosmetic polish, or optional extension without a concrete
  failure of the task. It is advisory, not a new acceptance criterion or repair round.
  Record advisory followups at the end of the roadmap when useful; otherwise retain
  the disposition in the PR. Do not create an issue for every suggestion.

Do not relabel a real LOW defect as advisory. Do not implement non-blocking polish
inside a blocker repair batch. An alleged defect may be rebutted only with reproducible
evidence in the ledger; disagreement about contract or authority goes to the arbiter.
No finding is silently dropped, and an issue number never makes a blocker landable.

## 3. Batch fixes; review only material deltas

A blocker closes only with a fixer delta plus independent focused review, an evidence-backed
ledger rebuttal quoting a reproducible command and its result, or an arbiter verdict within the
existing arbitration allowance. Explicitly prohibit re-prompting the raising reviewer under the
conductor’s contract reading as closure; that is not independent delta coverage or a rebuttal.
Before launching a focused reviewer, resolve OLD and NEW to full commit IDs and require
strict forward ancestry using this executable gate. Retain the resolved IDs for preparation,
review provenance and coverage records; textual ref/abbreviation inequality is not a delta.

```sh
# Focused delta gate
OLD=$(git rev-parse --verify "$OLD^{commit}") || exit 1
NEW=$(git rev-parse --verify "$NEW^{commit}") || exit 1
[ "$OLD" != "$NEW" ] || exit 1
git merge-base --is-ancestor "$OLD" "$NEW" || exit 1
```
A same-head re-read is not delta coverage and cannot close a blocker.

Before fixer dispatch, ship/topic must persist the verified PR-body read-back receipt in the
GitHub PR body: `Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>`.
Require successful edit and read-back of that receipt before dispatch and quote it in the dispatched fixer task; the fixer separately quotes it in the pre-push handoff when that record survives.
Land checks the same persisted receipt against the accepted dispatch-provenance source and requires its timestamp before dispatch; private notes or retroactive receipt creation do not satisfy the gate.
The fixer must post and read back a durable pre-push GitHub PR handoff comment quoting verbatim its dispatched `Repair round: N/3` line, dispatched `Pre-dispatch read-back` receipt, every assigned exact finding heading and source comment URL/anchor, dispatch time, and a reference to the hook-recorded pre-edit comparison with each checked comment ID and PR head.
The trusted project extension `.agentrig/extensions/dispatch-record.mjs` records every subagent dispatch after a PR exists, including the exact complete task, dispatch time, current PR head SHA and parent session id. Repair intent is detected anywhere in the task by `Repair round` or `Pre-dispatch read-back` (including inline prose, quoted history and examples), or by `OLD <SHA>` together with finding headings. Intent never falls back to an ordinary unchecked dispatch: require one operative standalone `Repair round: N/3` line and one standalone `Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <40-character SHA>; verified <ISO timestamp>` line with matching rounds. Malformed intent denies with formatting guidance; use marker-free prose for ordinary review tasks. Quoted/fenced historical receipts cannot supply the operative receipt or OLD. Repairs require a live PR. Above round 3, use `N/N` and first record one operative PR-body line `Human amendment: Repair round: N/N; authorization: <JSON-quoted verbatim human authorization>` for that exact round. This is a conductor-recorded human amendment, not automatic GitHub-author authentication; never invent an authorization or copy task text as authority. The hook fetches the live PR body, rejects absent/ambiguous/empty records and includes the checked authorization in its pre-edit comparison. A larger denominator or unrelated round amendment alone cannot authorize dispatch. Finding identity comes from the source comment’s canonical structured verdict headings when present (decoded JSON strings), otherwise exact legacy source lines; Markdown, Unicode and heading whitespace remain exact. Tasks may use `Finding: <exact heading>`, `<ID> heading: <exact heading>` (including severity-tagless headings), or a raw heading followed by `Source: <comment URL>`. A source URL may follow a finding or precede a labeled group. These are supported existing dispatch forms, not a new mandatory handoff template. Never strip heading bytes or use surrounding prose to override structured verdict identity.
The hook posts the dispatch comment and verifies its API read-back byte-for-byte before allowing the tool call; any lookup, post or read-back failure denies dispatch clearly.
Before starting a fixer, the dispatch hook fetches the live PR head and each cited source, compares OLD and every exact finding heading with its source, and posts `Pre-edit comparison: PASS` (or FAIL with mismatches) in the API-read-back dispatch comment. FAIL denies dispatch. Repair tasks pair each verbatim severity-tagged finding heading with its GitHub source URL on a following line before the next heading. This hook-recorded comparison replaces the handwritten fixer comparison.
Before a PR exists the hook leaves the initial builder invocation untouched; conductors do not manually post or read back dispatch-task comments.
Invoke every subagent without its optional `label` field so the immutable spawn preserves the exact task. The hook remembers the host own-line train-row binding from the user prompt for conductors working on main; otherwise it resolves the current branch PR.
The conductor must invoke the fixer subagent tool without its optional `label` field: immutable `subagent.spawn.task` records `input.label ?? input.task`, so only an unlabeled fixer invocation preserves the complete dispatched task for provenance matching.
Land may accept the hook dispatch comment matched to the immutable session-store `subagent.spawn` event by exact task text and parent session id as sufficient dispatch provenance; obtain the child session ID from that event. A missing durable fixer pre-push handoff alone is not a halt; when neither source exists land halts, and all receipt ordering, round/OLD/blocker identity, exact heading/source identity, and durable pre-edit comparison checks still apply.

Collect all declared initial verdicts before one repair batch. Give the fixer all blocking
finding texts/URLs, not the advisory list as new requirements. Keep the same PR.
Re-run the declared checks after repairs, retain fail-first and mutation evidence, push,
then return immediately so CI overlaps any necessary focused review.

Classify the complete delta since the last reviewed SHA, including CI/conflict fixes:

For conflict repairs, merge main into the branch; never rebase or force-push. Before
preparing a focused pass, verify OLD is an ancestor of NEW. If history was externally
rewritten, the old coverage chain is invalid: require the initial full pair on the
rewritten head, preserving the repair counter rather than certifying a false delta.

- **Material:** changes to executable behavior, security/authority, public interfaces,
  dependencies, task/skill workflow rules, or meaningful test expectations/coverage.
  Uncertain deltas are material. Use ONE independent reviewer over OLD..NEW and its
  direct interactions, normally the reviewer who raised the blocker. State the
  selected reviewer and reason. No fresh dual/full pass for each fix or commit.
- **Mechanical:** only spelling/formatting, broken links, or factual PR/STATUS receipts
  without changed guarantees. Record the diff, relevant checks and why it is mechanical
  as `self-verified mechanical delta; not independently re-reviewed`. A small executable
  fix is not mechanical. This exemption covers non-blocker bookkeeping only; it cannot replace
  independent focused review to close a blocker. Prior independent reviews remain evidence for unchanged code.

A focused reviewer verifies closure of the assigned blockers, tests the changed
behavior and relevant mutations, and checks direct regressions. Do not re-audit
unchanged code or demand optional cleanup. Newly discovered real blockers still
count; non-blocking observations go to §2, not another repair batch. Initial and focused reviewers judge code using conductor receipts; optional reviewer-owned probes
may support findings. The author and conductor run declared checks; exact-head hosted CI remains
required for landing.

### Declared reviewer slots and check ordering

The repository's `.agentrig/config.json` may declare `reviewers`: 0, 1 or 2 named slots.
Missing `reviewers` or `{}` means none; profile/home values do not silently supply reviewers.
The project config is the single source of truth for live slot model pins; workflow examples
and standalone test fixtures are not alternative project pin declarations.
Each slot declares only `adapter` and pinned `model`. CLI adapter definitions and launch commands
live in `scripts/reviewer-adapters.mjs`; `api:<name>` binds an existing named `providers` entry
whose model equals the slot pin. API entries retain their existing provider, endpoint, credential
and routing behavior; do not duplicate that configuration in reviewer slots.

Ordering is mandatory:
1. The author runs the declared checks green before push.
2. The conductor independently runs the same declared checks in its own tree at actual PR head:
   GREEN BEFORE launching any reviewer, including focused-delta review. Record bootstrap,
   preflight and named step commands, exit codes, UTC start/end, counts, head, worktree and TMPDIR.
   Empty steps mean no bootstrap/preflight and an explicit `declared checks: none` receipt.
3. Launch the declared reviewer slots with these receipts as inputs, never author reasoning.
   Reviewers judge code only; reviewers do NOT run checks. Optional reviewer-owned probes
   are evidence for findings, not a substitute for conductor proof. Dependency preparation in
   reviewer trees belongs to the conductor and must finish successfully before launch.
4. Hosted CI overlaps review and is required only at landing on the exact current head.
   Missing independent proof, failed checks, blockers or non-green exact-head CI prevent landing.

Zero slots skip external review entirely: ledger `External review: none declared`, flow
builder → declared checks → exact-head CI → land, using author check receipts without conductor-review
preparation. One slot is also the focused-delta reviewer.
Two slots run independently, sharing no builder context, preferably a different vendor or model.
Land requires only declared headings; never halt for an undeclared second slot. An incomplete
required slot gets one retry then halts. Wrong argument count or an invalid output prefix exits the adapter with usage error exit 64 before vendor launch and produces no prefix `.stdout`; this is a conductor error and does not consume the slot's single retry. A missing/pin-mismatched required review is not a pass.

Canonical initial heading:
`## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full — transport: <transport>; home: <JSON-home>`

For acceptance and rerun detection, validate the canonical prefix (slot, pinned model, reviewed head, recorded main and full marker), then require every newly posted CLI heading's transport/home suffix to match the trusted adapter provenance for that review: transportModel and JSON-quoted resolvedHome. The prefix alone is insufficient. Do not derive the suffix from spec examples, config, SHAs or local home guesses. Historical receipts keep their historical heading; new CLI headings retain #506 home provenance.

For CLI receipts with a resolved home, include transport model and JSON-quoted resolved home
in this heading, never only in the body. Historical receipts and transports without a CLI home
use the same heading without the transport/home suffix. Require the suffix for new CLI receipts. Missing reviewer homes or
invalid profiles are pre-launch configuration refusals (exit 64), not retry-consuming exit 2.
A reviewer schema-shape rejection where all required finding fields validate is a reviewer-protocol retry and does not consume the slot's single reviewer retry.
Keep full head/main provenance, asserted model source, adapter launch/provider entry, times,
exit and worktree in each linked review receipt. Land compares the model with the slot's pinned
model at the reviewed head; declaration changes are material and require newly declared slot
coverage, not retroactive relabeling. API adapter model provenance is the constructed provider's
model field, not a claim of wire-response attestation. Supply API reviewers the complete relevant
source/diff bundle with receipts; insufficient context is an incomplete review, never a clean verdict.

Pair and focused-review references mean only the declared slots; with zero slots skip external
reviewers, not check receipts, delta self-verification, CI or human authorization.

Per PR, at most THREE repair rounds, not a target. Normally there is one batched fix
and at most one focused review. Each round must close its assigned blockers without
reopening closed ones. A new blocker may use the next round; an unresolved assigned
blocker, reopened blocker, or blockers remaining at the cap halt with evidence.
Do not reset the counter after a push, conflict, restart, or reviewer change. Adopted
PRs recover the ledger and review history. Never land unresolved blockers to meet a cap.

## 4. Final join and receipt

The lander checks the initial review pair, every material delta's focused verdict,
mechanical-delta evidence, and each finding's disposition. Preserve explicit task
merge authorization and later revocations. Require green exact-head CI, then merge
one PR at a time and watch CI on the actual merge commit before continuing.

Report initial review URLs and SHAs, focused reviews and ranges (if any), mechanical
deltas, deferred defects/issues and advisory disposition, exact-head and post-merge
CI links, and child session IDs. Record review/CI start and finish times so overlap
and round count can be checked rather than claimed. Do not claim a workflow speedup
from instruction tests alone; a subsequent live shipment must establish that.

## Reviewer adapter and finding identity details

The conductor owns shared review-base refs and removes them only after all consuming jobs join
and restored state and publication are verified. Reviewers never create or delete shared refs;
a standalone reviewer owns only its unique private ref. CLI slots use the declared adapter
templates. The codex-cli adapter intentionally uses `codex exec`, not the dedicated `codex review`
subcommand: exec accepts the full skill prompt, exact model pin, explicit sandbox and last-message
output contract. This is not permission to change tool allowances or run project checks.
API review configs with top-level `config.dailyCap` are rejected before construction because the adapter has no
spend ledger; select an explicitly uncapped review config or CLI slot, never strip the configured cap.

Finding identity is the verbatim Markdown finding heading plus source comment URL/anchor. Run
`node <REPO>/scripts/review-finding-index.mjs <comment-URL>` on each posted review to produce a
small index from the live GitHub body (not a conductor summary). The ledger, pre-dispatch receipt
and fixer task retain that exact pair for every assigned finding. Conductor rationale stays
separate. Before dispatch, before fixer edits and before landing fetch the live comments and
compare all three copies; absent/edited/mismatched identity halts, never silently relabels a fix.

### Repair ledger and comparison-ref invariants

Every ledger row, including nonblocking deferred and advisory findings, must quote the live verbatim finding heading and source comment URL/anchor. Fetch all source comments live and compare exact bytes even when no fixer is dispatched; landing checks every row, not only assigned IDs.

Initial review preparation creates `git branch "review-base-NN" "$MAIN"` (NN is the PR number), refusing an existing ref, and records ownership; cleanup removes exactly that recorded ref after jobs join. Focused preparation/cleanup uses its recorded unique `BASE` instead. Neither `codex exec` nor dedicated `codex review` mode creates or owns these refs implicitly. The exec adapter uses the assembled prompt/artifact protocol, not dedicated review mode.

The API adapter refuses top-level `config.dailyCap` before provider invocation because it has no spend ledger; choose an explicitly uncapped review config or a CLI slot, never silently strip the cap. Finding indexing supports plain `F<n> — SEVERITY` and `[P<n>]` lines in addition to ATX headings. Recognizable unsupported findings follow the [structured review verdicts](#structured-review-verdicts) rule; fenced and quoted examples remain excluded.

## Structured review verdicts

`review-verdict.mjs` defines the zod wire schema in one delimited agentrig-verdict:v1
JSON block: version, reviewedHead (full SHA), assertedModel and modelSource, slot,
PASS/FAIL and findings with severity, exact verbatim heading, location file:line,
blocking boolean and scenario. Adapters append this contract to prompts and preserve
human prose. Posting, finding index and land validate the schema and binding instead
of a first-line Reviewed head gate, echo denylist or prose SHA-claim validator.
Delimiter lines must stand alone outside code fences, code spans and quoted examples; prose mentions are not blocks. Malformed/stale blocks fail closed. Only block-free historical prose gets a narrow
logged nonfatal display/index fallback; it cannot authorize landing. Schema heading
grammar is irrelevant. Unsupported recognizable prose findings are logged as nonfatal advisories, never silently dropped; the schema remains authoritative. Fallback accepts F<n> [SEV] title and F<n>: [SEV] title.
The posting helper keeps the machine block intact in one chunk (rejecting blocks that
cannot fit). For chunked reviews, validate the receipt-reassembled live body and index
only the schema-bearing comment; retain other chunk URLs as prose evidence, not duplicate
fallback findings.

## Completion-marker timing (canonical)

The conductor, not the builder or lander, sets the ROADMAP row's done marker in a final
docs-only commit after reviews and the disposition ledger resolve, before invoking land.
An early missing marker is advisory, not a blocker while the ledger is unresolved. Reviewers
must not request a repair round for that scheduled finalization. Cover the final docs-only
delta under the normal delta policy and re-verify exact-head CI. The land gate is unchanged:
the done marker must be present on the head being landed; land never adds it itself.

### Transport-proven family assertions (R18d / #500)

The configured minor pin remains exact: CLI adapters require their independently observed
transport provenance to equal it; API configured echoes only support exact assertions. Only a numeric GPT major-family assertion (`gpt-5` for `gpt-5.5` or a suffixed minor pin such as `gpt-6.7-variant`) may differ,
and only with that independent exact-pin proof. Different families, different minors, and
family assertions without transport proof fail closed. Verdict JSON cannot supply transport proof.
Adapter receipts retain `assertedModel` and `transportModel` separately; `model` and the canonical
heading retain the transport-proven pin. Prompts state the pin and transport source, offering the major-family assertion only for supported numeric GPT minor pins (including suffixed pins), without pretending the reviewer observed transport. Pass the trusted adapter receipt as the final `--validate` argument in shipping workflows and as
`post-review-comment.mjs --provenance PATH` (after `--config PATH`); both bind receipt to head, slot,
pin and verdict, and posting also binds the configured adapter. Never substitute reviewer-authored
JSON for the adapter receipt. Exact assertions do not waive durable evidence: structured review posting requires
the adapter manifest, and shipping workflows carry the actual adapter receipt through landing.

### Transport authority at the posting/landing boundary

API `provider.model` echoes the configured request label, not independently observed
transport identity. API adapters therefore record `transportModel: null` and require
an exact `assertedModel`; legacy API receipts carrying the configured echo cannot
authorize family relaxation either. CLI transport envelopes remain independent exact
pin evidence. Preserve the honest `assertedModel` and `modelSource` in all verdicts.

Headings carry the transport-proven pinned model (for API, the exact validated configured
pin, without implying independently observed transport). Retain the adapter-written
durable `provenance.json` and adjacent `review.md` outside cleanup roots. The posting
helper automatically validates and attaches the adapter manifest (receipt/output
paths and receipt digest) to the schema-bearing review comment. Keep that review
URL in the PR ledger; do not hand-copy manifest fields.
The scratch `<PREFIX>.provenance.json` is only a posting-compatible copy.
Posting may supply `--provenance <PREFIX>.provenance.json`. Land retrieves the durable receipt
from the attached review manifest, runs `node scripts/review-provenance.mjs --comment` as specified below,
then uses that receipt as `TRUSTED_ADAPTER_RECEIPT` with
`node scripts/review-finding-index.mjs --validate FILE REVIEWED_HEAD SLOT MODEL TRUSTED_ADAPTER_RECEIPT`
on the reassembled canonical body. Never reconstruct a receipt from the configured
pin or reviewer prose; missing or mismatched artifacts require recovery or an adapter rerun.


### Profile-scoped reviewer launch homes (#506)

Configure `profiles.<name>.childEnv` in `~/.agentrig/config.json` with nonsecret,
absolute `CODEX_HOME` and `CLAUDE_CONFIG_DIR` paths (see
[train operations](TRAIN-OPERATIONS.md#profile-scoped-child-environment-506)).
`agentrig --profile personal ...` passes the selected user environment to all CLI
children. A standalone adapter uses the same safe user-profile resolver:

```sh
AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO AGENTRIG_REVIEW_PR=NN AGENTRIG_REVIEW_PASS=PASS node scripts/reviewer-adapters.mjs <config> <slot> <prompt-file> <owned-worktree> <absolute-output-prefix> --profile personal
```

The existing five-argument form still works with explicitly inherited homes or the
CLI's inherited profile marker. The explicit config argument remains the operator's
reviewer declaration; project childEnv never overrides the user environment.
The adapter refuses missing homes with `REVIEWER_HOME_MISSING` before running a
reviewer or creating output. Run `agentrig doctor --profile personal` first to see
per-slot login status and visible identity without reading/printing credentials.

Adapter provenance now includes `resolvedHome` and `homeVariable` for CLI transports.
Pass the receipt via `post-review-comment.mjs --provenance <receipt>` as usual: the
posted heading displays the JSON-quoted resolved home beside transport model. Preserve that
receipt through repair/posting; a home path is provenance, not proof of account
identity. API adapters have no CLI home. Historical receipts without a home retain
their historical heading; new adapter receipts always carry the resolved home.

### Durable review evidence (#547)

Before every positional adapter launch, export `AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO`,
`AGENTRIG_REVIEW_PR=NN` and `AGENTRIG_REVIEW_PASS=PASS` (a unique initial or focused
pass name). Missing/invalid identity refuses launch. The adapter itself writes both
`review.md` and `provenance.json` under
`$HOME/.agentrig/review-evidence/OWNER/REPO/NN/PASS/ATTEMPT/`, using exclusive files
and a unique attempt id. Its stdout JSON supplies `receipt`, `output`, and `sha256`
(the receipt digest); the receipt binds the output digest and pass identity as well
as the head/slot/model/adapter/verdict. The posting helper automatically reads `<PREFIX>.durable.json`, validates its
receipt/output digest and repository/PR/pass/head/slot/model/adapter bindings, and
attaches the adapter manifest to the schema-bearing posted comment in an
`agentrig-review-evidence:v1` block. Keep the launch identity exports set during
posting. Do not manually copy manifests into the PR body: retain the posted review
URL in the append-only ledger for every successful slot and pass. OUT's
`<PREFIX>.provenance.json` is only a posting-compatible scratch copy, not the durable
artifact. The durable evidence directory is outside OUT, reviewer temporary roots,
proof TMPDIR and worktrees: never include it in scratch cleanup. Retain superseded
passes too. If HOME places it inside any cleanup root, halt before launch and fix
that environment; do not relocate evidence into temporary storage.

Before deleting scratch, fetch the posted review comment and validate its attached
manifest with the command below. Land, including a separate later session, consumes
the attached manifest from the live (reassembled if chunked) comment, never a manually
transcribed PR-body locator. It runs this gate BEFORE the existing comment validation:

```sh
node scripts/review-provenance.mjs --comment "$LIVE_REVIEW_FILE" "$REPOSITORY" "$PR" "$PASS" "$REVIEWED_HEAD" "$SLOT" "$MODEL" "$ADAPTER"
```

A missing receipt/output, digest mismatch, or identity/verdict binding mismatch
halts. This also compares the live structured verdict with the durable output. Use
the returned manifest receipt as `TRUSTED_ADAPTER_RECEIPT` for the existing
`review-finding-index.mjs --validate` gate on the live (reassembled if chunked)
comment; the durable gate does not replace live-comment checks. Never regenerate
provenance from prose/configuration. If landing on another host, transfer the exact
receipt and adjacent `review.md`, retaining the comment-attached digest and identity;
if unavailable, recover original artifacts or rerun review. Scratch cleanup never
deletes these durable artifacts and cannot be used to waive the land gate.


### Mechanical PR-body ledger integrity (#571)

The pre-tool ship hook guards `gh pr edit --body` / `--body-file` and `gh api`
pull PATCH body writes. The entire existing PR body is an append-only ledger:
retain every existing byte, including prior findings, resolutions, coverage and
counters; append a superseding correction instead of rewriting history. A fresh
empty body may be populated. The guard fetches the live body and validates cited
issue-comment, inline-review-comment and review URLs against fetched comment IDs
and exact `html_url` values. Missing comments, wrong anchors, malformed responses
and fetch timeouts deny before the write. Use one literal gh command, an explicit PR
number/URL, and a regular body file (not stdin); shell interpolation/operators are
not verifiable and must not wrap a body mutation. This pre-tool guard is not a GitHub
transaction: land still re-fetches the ledger and checks completeness before merge.

For new repair dispatches use one standalone `Finding identities: ` line followed
by a JSON array of `{ "heading": "exact source heading", "url": "source comment URL" }`.
Take `heading` directly from structured `findings[].heading` without adding severity
or Markdown decoration; preserve quotes, backslashes, leading/trailing whitespace,
Unicode and delimiters. JSON escaping transports those bytes losslessly. The guard
uses these identities for PR-body edits as well as repair dispatches. A newly cited
structured review with findings requires explicit identities; prose-only substitutes
are refused. It parses structured findings and compares exact decoded strings, never JSON-line or
surrounding-prose approximations. Legacy exact heading/source records remain
supported. Append source identities and resolution evidence; do not collapse them.

## Structured child results

Builder/fixer handoffs use the ship pack's `ChildResult` discriminated contract,
not the train host's final landed `{pr}` receipt. A PR handoff requires status, PR
number and exact head; a blocked handoff requires a classified kind and evidence.
The shared typed-handoff skill section requires the optional subagent output schema
and the pack assessment helper. The conductor verifies PR/head against the scoped
repository and task, and blocker necessity independently. Scope blockers require at
least one verified necessary outside-row path; in-scope-only paths fail. Invalid or
unverifiable results consume a failed attempt: redispatch builder once carrying all
previous notes, then halt on a second failure. Persist the counter across resume.
These checks grant no permission, scope expansion, review waiver or merge authority.

### Verify every typed blocker (#582)

A blanket `verifiedBlocker` assertion is insufficient. The shared child-result contract
requires environment citations matched to command/exit/output in the spawned child's own
immutable session events; dependency issue/PR/row references checked against fresh API state;
and ambiguity's inspected conflicting paths/sections plus question routed to the arbiter,
not a blocker halt. The pack helper checks conductor-owned observations, not child-supplied
verification booleans. Missing or unverifiable evidence is a failed attempt under the existing
one-retry rule. Incomplete execution is not an environment blocker. See shared child-results
in the dogfood/ship/topic skills for exact citation and observation shapes.
