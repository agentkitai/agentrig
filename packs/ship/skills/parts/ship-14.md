## 1. Build

Apply dogfood §1 to builders, continuation builders and fixers in every handoff: use an
owned worktree created from `origin/main` for new work, or attach/reuse the existing branch's
owned worktree for continuations and repairs. Never change the author checkout's branch.
Require the worktree path in the PR body and remove it after recording handoff, with all jobs
joined, tracked/index state restored and proof persisted. The conductor removes recorded owned
leftovers after landing under the same checks; never remove the author checkout or unowned trees.

- Spawn a subagent with a self-contained task: the issue/roadmap row to implement, plus
  "Follow the dogfood skill. You are a ship child: stop at the PR and skip the external reviews —
  an independent review follows." Include everything it needs in the task text — a subagent
  gets none of this conversation.
- If its report ends with `DEVIATION REQUESTED`, do not judge the proposal yourself: spawn an
  `arbiter` subagent with the proposal, the contract verbatim, and the human's invocation line;
  on APPROVE spawn a continuation builder on the same branch carrying the verdict block and the
  arbiter's session id; on REJECT spawn one carrying the rejection and "build the row as
  written", or stop for the human if the builder said the row as written is infeasible.
- Its report should name the PR it opened, the head SHA, and CI state on that head.
  Explicitly tell builders and fixers: return immediately after push/PR, without waiting for
  hosted CI; the conductor starts review and CI monitoring concurrently. If it died
  at its turn budget instead, report its session id so the human can resume it
  (`agentrig sessions resume <id>`), and stop — do not re-spawn a fresh builder over a
  half-pushed branch.

Remove registered worktrees with `git worktree remove <path>`, then `git worktree prune`
after the recorded handoff and join/state/proof checks. Never use bare directory deletion
for a worktree; remove the owned proof TMPDIR separately.

## 2. Review, independently

`<REPO>` is the absolute path to a separate clean checkout at the fetched base-branch commit,
NEVER the PR head. Prepare it using `topic` §2 step 4's **Adapter checkout boundary**: record
literal path, base SHA and preparation receipt; prepare required dist from that same base.
Load review/ship/topic/land/arbiter skills and run adapter, schema, posting and finding-index
helpers from this base-pinned tree, never copies from the PR under review. Keep reviewed source
and config in the separate PR-head reviewer tree. A tooling-changing PR is data, not its own
review authority. Never use the author tree or stale main dist. Retain the base tree until all
adapter jobs join and receipts are persisted. Empty checks authorize no undeclared build;
if required dist is unavailable, halt rather than run undeclared checks.

Never review in this session. Prepare exactly as `topic` §2 step 4 prescribes.
Resolve declared reviewer slots at the actual PR head and follow topic §2 step 4's preparation,
independent conductor proof, adapter launch, validation, posting and cleanup sequence exactly.
Before any reviewer, create an independent conductor tree at current PR HEAD and run the resolved
bootstrap, optional preflight and ordered declared checks; require GREEN BEFORE launching any reviewer.
Do not review an integration-only SHA: update the PR and re-prove first. In each reviewer-owned tree
conduct dependency preparation and gate on exit zero separately; empty steps run no commands.
Pass named receipts with head/commands/exits/counts/times as inputs. Reviewers judge code only;
reviewers do NOT run checks. Optional reviewer-owned probes may support findings.
Zero slots: record `External review: none declared`, skip review worktrees and jobs, and follow
builder → declared checks → exact-head CI → land. One slot: only it runs and it also owns focused
material-delta review. Two slots launch in parallel in separate reviewer-owned worktrees you prepare; both launch independently. Beside the launch, use this positional contract exactly once: `AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO AGENTRIG_REVIEW_PR=NN AGENTRIG_REVIEW_PASS=PASS node scripts/reviewer-adapters.mjs <config> <slot> <prompt-file> <owned-worktree> <absolute-output-prefix>`. An adapter usage error (exit 64 before vendor launch, with no `<absolute-output-prefix>.stdout`) is a conductor error and does not consume the slot's single reviewer retry. Hosted CI
monitoring starts immediately and overlaps reviews; green hosted CI is required only at landing.
Never pass builder context. API reviewers receive the relevant source/diff bundle and receipts.

Use the configured slot name with `scripts/post-review-comment.mjs`, the adapter's transport-pinned model
file, verdict file, full reviewed HEAD and MAIN, and check receipts. Do not compose headings inline.
Read back all canonical comments and durable chunk receipts before accepting them; use `head -1`
for the heading, not a complete chunk check. Compare each model to the slot's pinned model.
Reuse a complete current-head pass only for the declared slots; never demand an undeclared second
heading. Preserve older full reviews and focused delta coverage through the current head. A clean
main advance re-verifies CI, not a redundant initial pass. Never duplicate a completed review just
to improve its verdict. Failure/staleness/retry cleanup follows topic's Review scratch cleanup.

Follow topic's **Adapter checkout boundary**: use base-pinned skills and helper scripts,
never copies from the PR under review. Record the base SHA/path separately from reviewed HEAD.
Before posting, use the current adapter verdict artifact, not prompt/tool logs. Validate its
single delimited agentrig-verdict:v1 block against the base zod schema and expected full
reviewedHead, assertedModel and slot. Preserve prose; there is no first-line head gate,
echo denylist or prose SHA-claim validator. Invalid structured blocks fail closed. A missing
block permits only narrow logged nonfatal legacy prose fallback for display/indexing, not landing.
Schema finding headings have no grammar; fallback accepts F<n> [SEV] title and F<n>: [SEV] title.
Above 40 KiB of reviewer-body UTF-8 bytes, first record a nonempty size explanation in the conductor
ledger and export `REVIEW_LARGE_BODY_LEDGER` to that ledger file before posting. The posting receipt
retains the explanation; preserve lossless genuine multi-chunk reviews, never summarize to fit.
Apply topic §2’s shared extraction and slot posting gate with the configured adapter id before invoking `post-review-comment.mjs`.

## 3. Resolve the verdict, then honor the merge decision

- Present the verdict verbatim-in-substance: every finding with its severity, or the pass with
  its evidence, plus PR number, CI state, and the initial review URLs and any focused delta review URL. This is a progress report, not an unconditional stop.
- Apply shipping policy §2 to every finding. Batch blocking repairs only; defer non-blocking
  defects with issue links and advisory polish to the roadmap when useful. Contract or
  authorization findings still go to an arbiter before the fixer.
  A fixable verdict does not wait for the human: perform authorized blocking repairs unasked.
Every ledger row, including nonblocking deferred and advisory findings, must quote the live verbatim finding heading and source comment URL/anchor. The ledger hook validates source identity before writes; retain review-resolution judgment.

Above round 3, use `N/N` and first record one operative PR-body line
`Human amendment: Repair round: N/N; authorization: <JSON-quoted verbatim human authorization>`
for that exact round. This is a conductor-recorded human amendment, not automatic
GitHub-author authentication; never invent an authorization or copy task text as authority.
A larger denominator or unrelated round amendment alone cannot authorize dispatch.
Hook validation checks syntax, not human provenance.

Before calling a fixer, perform this ordered persistence gate (including on resumption):

1. Persist the PR body with `gh pr edit NN --body-file <ledger-file>`: update
   `## Review disposition` with every finding, its severity and disposition; increment
   `Repair round: N/3` (at most 3, never reset on restart), recording OLD and assigned blocker IDs.
   Update `## Residuals` with deferred defect issue links or none. Require edit success before proceeding;
   a private note or an instruction for the fixer to update it later is not persistence.
2. Only then perform this read-back gate. Read back `gh pr view NN --json body` BEFORE
   spawning the fixer subagent; verify the
   persisted `Repair round: N/3` and assigned ledger blocker IDs match the intended handoff.
   Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim in the dispatched fixer task.
   Dispatch only ledger-blocking findings. Nonblocking defects go to residual issues; advisory
   notes are not repairs. Record any reclassification in the ledger first with its rationale, then edit and read back
   again before dispatch. Missing or mismatched persistence halts; never delegate its creation.
3. Persist the verified read-back receipt in the GitHub PR body BEFORE dispatch:
   `Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>`.
   Fill it from step 2's actual read-back, with its UTC timestamp; retain earlier rounds' receipts.
   Require edit success and read back the receipt with `gh pr view NN --json body`;
   verify the receipt, round, OLD and assigned IDs still match. Any mismatch halts dispatch.
   Quote this persisted receipt in the handoff alongside the round and blockers.
   For each assigned ID, copy the exact verbatim finding heading and comment URL/anchor from
   the live posted review into the ledger, pre-dispatch receipt and fixer task. Keep conductor
   paraphrases in a separate rationale field, never as finding identity. Generate the index with
   `node <REPO>/scripts/review-finding-index.mjs <comment-URL>` after reading the posted review;
   retain its comment anchor and exact heading per finding, including collapsed duplicates.
   The pre_spawn hook owns dispatch posting/read-back, pre-edit source comparison and
   resume PR association. Its refusal is binding; do not recreate its records by hand.
   Carry the persisted receipt, exact finding identities and counter in the fixer task.

- Spawn the fixer on the same branch with exact blocker texts/URLs. After its local proof and
  push, classify OLD..NEW under shipping policy §3: ONE independent focused reviewer for a
  material delta, evidence-only for a mechanical delta. Use topic §3's **Cover the delta** procedure
  for isolated preparation, installation, launch, provenance and cleanup. Never repeat the initial external pair
  for each fix. At most three repair rounds, preserving the counter on resumption; unresolved
  blockers or non-convergence halt, while new advisory notes do not open another round.

Before spawning the named lander child, read `gh pr view NN --json body`.
Fetch linked review comments too (for example `gh api repos/OWNER/REPO/issues/comments/ID`);
verify all declared initial canonical headings in the actual comments, including each slot's pinned model,
reviewed head and main provenance. Verify `## Review disposition` contains dispositions for every
finding from all declared initial reviews and every focused review, and `## Residuals` has issue links or
explicit `none`. Verify all blocker closures and delta coverage through current head. Missing
headings, comments, dispositions or residual records halt BEFORE land-child spawning; a URL alone
or a private summary is not verification. Persist edits then read back again if anything changes.

- When scoped merge authorization is present, dispatch `subagent` with `agent: "lander"` to follow the `land` skill without asking for a second approval. Pass the verbatim human quote, task scope
  and PR number; require green exact-head CI and watch post-merge CI before reporting completion.
  Otherwise report the reviewed PR and wait for explicit merge authorization.
- No answer is an answer: never treat silence, a timeout, or your own confidence as approval.
  A run awaiting missing authorization is a reviewed PR awaiting authorization, not a completed
  end-to-end shipment. An authorized run is complete only after land reports green post-merge CI.

Follow shipping policy **Completion-marker timing (canonical)** for final docs-only
finalization before land; do not dispatch an early marker repair while the ledger is unresolved.

## 4. Budget and honesty

- Keep your own turns few — the work happens in the children. If a child fails, relay its actual
  failure; never paper over red declared checks or a review finding to make the cycle look complete.
- Every child has its own session log; name the session ids and the URLs of the declared external
  initial review comments and any focused delta review in your final report so the full audit trail is one
  `sessions show` away.
