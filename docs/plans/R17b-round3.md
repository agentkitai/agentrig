# R17b final repair round 3 of 3 — PR #234

Builder **agentrig**, conductor **2aa2f739**, fixer **b12646c7** (sixth known
implementation/arbitration child). Adopted old head
`e5b8044f86b9edbcc7ada95e2c7dde8db6e9d715` in the existing single worktree
`/home/amit/agentrig/.claude/worktrees/r17b-defaults`, branch `feat/r17b-defaults`.
Current main was already an ancestor. No rebase, child spawning, external
review, merge, second arbiter, new exception or round reset.

The original `/topic R17` authorization, arbiter **1bb8ec86** sandbox RECORD,
and outside-train human **#248** diagnostics resolution remain unchanged in the
PR. Previous builders **7dbfad2b**, **b9109d9f**; prior fixers **12b8dd75**,
**633e8e44**; prior conductors **8fbde1a3**, **38c4612d**; current conductor
**2aa2f739**. Round-1 and round-2 artifacts are history, not rewritten evidence.

## Complete authoritative findings

- Claude: https://github.com/agentkitai/agentrig/pull/234#issuecomment-5575280407
- Codex: https://github.com/agentkitai/agentrig/pull/234#issuecomment-5575280619

| Finding | Repair and fail-first evidence |
| --- | --- |
| Claude HIGH 1 — dirty-tree-dependent review profile test | Use deterministic `review --profile recommended --comment` validation, before diff collection/provider construction. Inject throwing provider and process spies and assert neither was called. No dependency on local edits, credentials, Git contents, or billed calls. The regression mutant removes `--comment`, is caught by the process-spy assertion, and fails whether the checkout is clean or dirty. Old-head hosted run 34157135772 is the genuine red receipt, not retried away. |
| Claude HIGH 2 / Codex P2 — references-only false clean | Default tsc adds `--listFiles`; the existing tsc parser recognizes canonical listed paths and requires the touched file in that list before reporting completed coverage. Empty zero-exit solution runs and excluded files are explicitly incomplete. No tsconfig text matching, reference traversal/build, diagnostic narrowing, or mixed-reference exclusion. Real-compiler/fake-model fixtures cover files-empty references, JSONC references, mixed root sources/references, excludes, missing config, and clean included file. Coverage-guard deletion and default-argument deletion each fail; original source initially failed references-only and JSONC with reported instead of incomplete. Custom checker arrays remain overrides; without listFiles their prior semantics remain unchanged. |
| Claude MEDIUM 3 — silently ignored recommended name | Profile-aware non-run commands without a user/project override emit an explicit note that recommended run defaults do not apply and retain their command baseline. Profile-ignorant commands already emit an ignored-profile note; now tested for recommended. No implicit hooks are added to review/eval/doctor. Deleting the new notice branch fails the notice test. |
| Claude LOW 4 — vacuous verbose=false row | Drop the redundant false row explicitly as requested. Keep only persistent verbose=true; the exact reviewer pass-through-deletion mutant in tui/start.tsx fails the remaining test and restored source passes. No new false-persistence claim. |
| Claude LOW 5 — emit-after-prune recovery claim | Qualify docs: interruption before the transaction keeps refs, but transaction success followed by failed seal-event append has already pruned older refs while the log remains unsealed; undo refuses. No atomicity reopening or broader recovery guarantee. Documentation-only correction; no behavior mutant claimed. |
| Claude LOW 6 — missing smoke helper | Replace the nonexistent .agentrig/r17/recommended-smoke.py reference with the committed docs/plans/R17b-repair-smoke.py and link this reproducible round-3 receipt. Documentation-only correction. |
| Claude LOW 7 — misleading retained-ref terminology | Undo and diff errors now say “last two mutating-turn refs,” consistent with DEFAULTS retention terminology. Assertions strengthened for both paths: old wording fails both suites; each independent wording mutant is killed and restored source passes. |
| Claude final unverified-evidence paragraph | Explicitly correct round-2 trio/receipts as historical dirty-tree-only, not clean-old-head or reviewer-reproduced evidence. Preserve old artifacts. Round-3 fake-only reproduction and clean-head gates are recorded separately below; nothing asserts reviewer reproduction. |

## Reproduction and evidence boundaries

From repository root, after `pnpm install`:

```
TMPDIR=/var/tmp python3 docs/plans/R17b-round3-mutations.py
pnpm build
TMPDIR=/var/tmp python3 docs/plans/R17b-repair-smoke.py
TMPDIR=/var/tmp python3 docs/plans/R17b-repair-terminal.py
AGENTRIG_REPAIR_RECEIPT=/tmp/R17b-round3-e1.json node docs/plans/R17b-repair-e1.mjs
pnpm test
pnpm typecheck
```

Mutation results: `R17b-round3-mutations.json` includes commands, exact source
mutations, full captured output and exits. Seven independent probes are required
to be red with the mutant and green after restoring source; the script restores
bytes in `finally`. The scripts use loopback fake providers and the pinned local
E1 bundle, not external provider calls. `AGENTRIG_REPAIR_RECEIPT` lets E1 write a
new receipt without replacing the old round-1 artifact. Timing observations are
fixture-only, not live-provider performance claims.

Round-2 historical local trio: **213 files, 3379 passed / 4 skipped**, all three
reported exits zero on the dirty implementation tree. It does **not** establish
clean old-head success. Hosted run **34157135772** at the old head failed Ubuntu
and macOS at recommended-defaults.test.ts:117; Windows passed. Structure passed
separately. Neither independent reviewer reproduced the PTY/E1 receipts.

Clean candidate **47b4ecd464a3ef769a4e5753081c15c2ee5adf09**: `pnpm build`
exit **0**, `pnpm test` exit **0** (**213 files, 3386 passed / 4 skipped, 3390
collected**), `pnpm typecheck` exit **0**. Git status was empty before and after.
The final receipt-only commit is rechecked with the same clean-tree trio before
push; exact final SHA and exits are recorded in PR #234. Hosted status at receipt
commit: **not yet pushed/not run**, not green; actual push-head status is in PR.

Reproduced on that clean candidate (not by an independent reviewer):
- `R17b-round3-smoke.json`: exit **0**, all acceptance booleans true. Fresh
  zero-config PTY fixture, rendered Markdown, visible diagnostics line and
  checkpoint, one ingest request. The diagnostic exec approval was explicitly
  declined: this smoke is line visibility, not compiler-success evidence.
- `R17b-round3-terminal.json`: exit **0**, cold prompt **390.84 ms**, first
  streamed token **62.07 ms**, loopback fake provider only, one observation.
- `R17b-round3-e1.json`: exit **1**, deliberately **not** a green E1 claim.
  Six task checks PASS; A4/X4 remain BLOCKED pending manual adjudication, all
  eight behavior checks PASS. Seven unavailable-checker tool errors across
  A1–A3 are retained (same fixture PATH limitation as round 2). All eight sessions
  ended done and all eight ingest reports completed. Prompts/turns: A1 4/4,
  A2 4/4, A3 6/5, A4 2/5, X1–X4 2/4 each. This reproduces bounded fixture
  observations, not live capability, all-E1-green, or working-compiler claims.
  Real-compiler diagnostics coverage is proved separately by the regression
  tests and fail-first probes, not this E1 fixture.

No old smoke, terminal, E1 or mutation JSON receipt was overwritten.
Independent delta review is the conductor's next gate, not this child's work.

## Accounting and feel

Six known implementation/arbitration children for this row; zero spawned by
this child. One historical halt (#248, human-resolved), no new halt. Historical
round-2 main-model snapshot remains **247595 uncached input + 15526 output +
938752 cached input = 1201873** tokens, auxiliary separate; not a row total.
Final child totals are unavailable until completion; any reported current
session usage is explicitly a snapshot. No new AgentRig friction observed.
Prior feels include #251 (orphan worktree index.lock) and #252 (first Claude
provenance failure). Prior external jobs: Claude job-6 rejected; sole
claude-opus-5 retry job-8 passed; Codex job-7 passed. Their posted review URLs
above are authoritative. No review was rerun by this child and no gate lowered.

Current fixer main-model snapshot through canonical session event seq 688
(57 model.response events): **337277 uncached input + 17980 output +
1288576 cached input = 1643833** tokens. Auxiliary separate;
this excludes later turns and is not a final session or row total.
