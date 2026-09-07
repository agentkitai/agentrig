# R17b repair round 2 of 3 — PR #234

Builder **agentrig**, conductor **2aa2f739**. Adopted
`bf66779439f3e077c3d2f5b7a6c1a22a56c8bb1f` in the existing single worktree;
merged `origin/main` `8c23c70369a539422d0782894fad71cad17341f0` (never rebased).
The STATUS merge conflict retained both histories. Before implementation, STATUS
and the PR recorded prior halt feel **#248**, the outside-train human resolution
(restoring diagnostics to the existing acceptance), and updated authorization.
No second arbitration, new builder worktree, children, external review or merge.
The approved sandbox exception and completed round-1 record are unchanged.

Authoritative findings:
- https://github.com/agentkitai/agentrig/pull/234#issuecomment-5574833256 (Claude 1–8 and Could not verify)
- https://github.com/agentkitai/agentrig/pull/234#issuecomment-5574833438 (Codex P2)

## Every finding and resolution

| Finding | Resolution / evidence |
| --- | --- |
| Claude HIGH 1 | Keep implicit tsc even without root tsconfig, including this monorepo. Do not narrow the roadmap. Missing project/compiler or denied exec remains a visible unavailable/incomplete diagnostic, not a false clean result. Runtime fixture no longer manufactures a tsconfig. Fresh no-config PTY fixture likewise has no tsconfig. Existing exec permission and fail-closed checks are unchanged. |
| Claude 2 | DEFAULTS now documents Ruff `check --output-format=json -- {path}`, Python-root applicability, and tsc's unavailable/incomplete reporting without a root project. |
| Claude 3 | `undoSession` and TUI `/diff checkpoint <turn>` report `checkpoint turn N is unavailable (pruned or missing); only the last two sealed turn refs are retained`. Ref presence checks precede revision resolution; undo/diff assertions require the message. DEFAULTS documents both consumers. |
| Claude 4 | Mounted `startTui` test covers verbose true and false, asserts the actual controller snapshot outside startup's error-catching boundary. It is a normal `*.test.ts` included by `pnpm test` in CI. Exact reviewer mutation (delete line 67, the verbose spread) now fails 1/6 startup tests, restored source passes 6/6. No dependence on the non-CI PTY script. |
| Claude 5 | Built-in `recommended` is recognized outside run-capable commands as a baseline alias, without enabling run hooks there; user-defined recommended profiles still overlay normally. Real review CLI dispatch test verifies it reaches review validation rather than unknown-profile failure. |
| Claude 6 | PLAN checkpoint and destructive-supervisor sections now describe config keys and explicit trusted provenance, not removed `--supervise` / `--checkpoints` flags. |
| Claude 7 | Regenerated `R17b-repair-e1.json` with the corrected `tool.result && ok === false` extractor. Committed the exact fixture script. It now honestly records seven unavailable diagnostic tool results across A1–A3, not eight vacuous empty arrays. See limitations below; the old no-errors claim is withdrawn. |
| Claude 8a + Codex P2 | Removed raw-text JSONC references detection entirely: no root tsconfig parsing is needed to retain tsc. Tests cover absent config, references-only, references + include, and a JSONC comment containing references. Thus valid mixed compilation/reference roots cannot be silently disabled. |
| Claude 8b | One `git update-ref --stdin` transaction creates the seal ref and compare-deletes old numeric refs. No process per ref. `option no-deref`, numeric-only filtering, last-two retention and OID comparison remain. |
| Claude 8c | Transaction finishes before sealed event emission. A locked old ref proves failure emits no seal, creates no sealed ref and retains all four turn refs. Retry proves the sealed-event callback observes already-pruned refs. Old implementation fails that assertion. |
| Stale hosted CI | Adopted bf66779 head had four green checks, not pending. Those checks are historical, not new-head evidence. New pushed head will be reported independently in the PR. |
| Could not verify: mutation | Committed reproducible script and output `R17b-round2-mutations.{py,json}` rerun three load-bearing mutations, all mutant exit 1 / restored exit 0. Earlier 18-probe claims remain historical only, not asserted as rerun/current-head evidence. |
| Could not verify: PTY/terminal/smoke | Committed runnable scripts and fresh round-2 receipts for both no-config and expanded smoke, each exit 0. Both show rendered Markdown, diagnostics line, checkpoint and ingest. Terminal sample exit 0: cold prompt 523.727 ms, first streamed token 89.230 ms, root help 2 options. Single local samples, not performance claims. |
| Could not verify: E1 | Replay actually rerun; artifact refreshed with real error events. Seven unavailable diagnostic results make its strict no-tool-errors guard exit 1. All eight behavior checks PASS; X4 overall BLOCKED pending human prose assessment, not a complete E1 pass or human verdict. No hidden retry or ignored exit. |

## Reproduction and fail-first

From the repository root after install/build:

```
TMPDIR=/var/tmp python3 docs/plans/R17b-round2-mutations.py
TMPDIR=/var/tmp python3 docs/plans/R17b-repair-smoke.py
TMPDIR=/var/tmp python3 docs/plans/R17b-repair-smoke.py --expanded
TMPDIR=/var/tmp python3 docs/plans/R17b-repair-terminal.py
TMPDIR=/var/tmp node docs/plans/R17b-repair-e1.mjs
```

Mutation script temporarily changes only its named source and restores it in
`finally`; run in a clean worktree. Exit 0 means all three mutants failed and all
restored tests passed. Initial pre-fix diagnostics, pruned undo and manual diff
assertions also failed before implementation (9 failures / 77 passes across the
three targeted files). The corrected real review test is included in the replay.
An initial deletion probe matched no source line and therefore was not evidence;
the committed script checks that every mutant actually changes bytes.

Final local restored-source gates: `pnpm build` **0**, `pnpm typecheck` **0**,
`TMPDIR=/var/tmp pnpm test` **0**, 213 files, 3379 passed / 4 skipped.

## Evidence limits and supersession

Round-1 history is retained, but its skipped-tsc behavior, E1 empty-tool-error
claim, unqualified 18-mutant current-head implication and pending hosted-CI
sentence are superseded, not claimed for round 2. All current claims above have
committed reproduction scripts or CI tests. No live-provider or E3 rerun is claimed.
E1's diagnostics errors say `checker failed to start (exit unknown)`; the fixture
provisions no tsc in task snapshots. This is expected unavailable reporting, not
successful TypeScript compilation. PTY smoke explicitly denies diagnostic exec;
it proves a visible diagnostics line while preserving permissions, not a clean
compiler run. Smoke also shows the existing safe seal refusal when ingest writes
unignored wiki files (main #247 explains it); checkpoint-created acceptance is
not a claim that every session can be undone.

## Accounting / feel

Prior builder/arbitration children: initial **7dbfad2b**, arbiter **1bb8ec86**,
continuation **b9109d9f**, round-1 fixer **12b8dd75**; prior conductors
**8fbde1a3**, **38c4612d**. This is the fifth known implementation/arbitration
child, builder agentrig under conductor **2aa2f739**, not a new round count.
Its own session ID/token telemetry is not exposed in this tool surface; do not
invent it. Spawned children: **0**. External-review child accounting is not
available here. Existing `R17b-repair-accounting.json` is a historical partial
snapshot, not a current total. Prior halt: **#248**, human-resolved outside train;
no new authorization halt. Commit encountered an orphan worktree index.lock;
feel **#251** records the exact command, conductor session and inspection before
removing the orphan and retrying. Cause is unverified, not attributed to agentrig.
Historical feel **#235, #236, #241–#246** remain preserved.
No remaining known unfixable HIGH. Independent delta reviews still required by
the conductor; this child stops at push and never merges.
