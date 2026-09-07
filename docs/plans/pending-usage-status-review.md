# Independent review — missing usage status

One read-only Claude review of frozen088619c against ebfd10f. Requested max24;
reported 16 turns. Session `25ffa85d-b78d-4613-abcd-b1b482440269`, duration 94790ms,
API duration 83107ms, is_error=false. No restart/continuation or second review.

## Original result (verbatim)

Review complete. Writing up the findings now.

**Verdict: approve with two low-severity notes.** The change matches the contract in docs/plans/pending-usage-status.md. It adds one optional read-only count to the in-process report, changes footer wording only, and touches no persisted schema, admission, settlement, permission, or observer lifecycle code.

**Executed commands and results**

| Command | Result |
|---|---|
| `git diff ebfd10f..HEAD` | 8 files, 137 insertions, 10 deletions, clean tree |
| `pnpm exec vitest run` on the three allowed test files | 3 files, 63 tests passed |
| `pnpm typecheck` | all four packages clean |

No commands were denied. No edits, git mutations, agents, providers, or network were used.

**Findings**

- **Low, `packages/cli/src/tui/status.ts:11`. Zero-call reports now read "unreported".** Before this change a report with no calls in the window fell through to the priced branch and rendered a numeric zero cost. Now the new guard fires first, because both complete calls and snapshots are zero. That is arguably more honest, but it is a wording change beyond the "held first call" case the contract describes, and no test pins it. Worth a one-line note in the plan or a fixture with zero calls.

- **Low, `packages/cli/src/tui/status.ts:11`. Absent field is treated as zero, which can hide real tokens on a legacy-shaped report.** A report lacking the count but carrying nonzero reported usage and no complete calls would render "unreported" instead of the token quad. In practice this cannot happen: the report is only produced by the in-process ledger, which always sets the count, and it never crosses a file or process boundary. It only matters for hand-built fixtures like the one in tui-status.test.ts. A stricter fallback would show the numeric quad when the field is undefined and usage is nonzero.

**Verified correct**

- The ledger count is incremented under the same window and segment filter as reported usage, so the two are scoped identically as the contract requires. Fold validation already guarantees a priced settlement has a usage snapshot, so complete calls can never exceed snapshots and the footer branches are exhaustive.
- The /cost text path in usage.ts is untouched and still reports the token quad with its existing "unknown coverage is not zero" wording.
- The held-provider App test snapshots ledger records before mounting and asserts equality after, so the observation path does not write. The mixed test confirms one snapshot among three calls keeps the "+?" and reserved suffixes. Mock cleanup is handled by the file-level afterEach restore.
- The three test-count and control-count claims in the plan and STATUS docs match what actually exists and ran.

**Omitted checks**

- Full suite, build, Docker suite, Chromium, and hosted CI gates were outside the allowed scope and were not run.
- Other CLI test files that render the footer were not executed, though a grep found no assertion on the old zero-call label outside the three files run.

## Author disposition

Both low notes are addressed within the same item. A zero-call window is explicitly
unreported and pinned by a formatter test. Legacy-shaped reports with nonzero usage
now retain that numeric evidence; an actual formatter regression failed before this
closure and passes afterward. The current in-process ledger always emits the count,
so this is compatibility defense, not an observed production transport failure.
Original three held/missing runtime failures remain separate author evidence.
The reviewer used fake providers through the permitted tests; “no providers” in the
original means no live providers, not that provider fixtures were absent.
Full Docker and Chromium receipts are author checks, not independent review claims.

