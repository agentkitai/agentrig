# R17f preparation reviews — before live collection

One general pass per independent reviewer on frozen `a09688a6ba0c04f089e07f830cb6bc5f872a5716`,
against main `2a8ea5968e665dbf84456b138d8f5219d741c18a`. Builder preparation was `ce5aeea`,
Claude session `00089fc1-9e72-4dc2-899d-0ddde8fcbb0c`; operator integration followed.
All work is outside AgentRig; no conductor or dogfood success is claimed.

## Independent evidence

- Claude Code session `01f7427f-deea-450a-b6df-1ed630ca2920`: build, typecheck, actual
  fixture preflight, full suite **3584 passed / 4 skipped / 231 files**, fifteen focused
  benchmark tests, plus standalone probes. Also exercised the selected `heuristics+llm`
  arm with a fake provider and observed a correctly paired auxiliary usage snapshot.
- Codex session `01a082ed-b505-78b1-ad38-dfe54622089e`: executable probes for failed
  cleanliness verification, admission/journaling, unknown-call stop, original corpus
  recovery and balanced-prefix analysis. Its sandbox denied writable `/var/tmp` fixtures
  and default `/tmp` failed preflight on a foreign `.git`; it did **not** run Vitest or
  build/typecheck. A child-process capture probe was denied, not passed. Root and Claude
  supplied the host-side test evidence; no environment guard was bypassed.

## One grouped repair

1. Failed `git status` with empty stdout could look clean. Refuse failed or infrastructurally
   incomplete revision/cleanliness commands before Docker preflight or provider use.
2. A large parsed command could open a scoped-grant draft whose preview failed; allow-once
   then did nothing while the draft remained open. Cancel the draft before allow-once,
   and pass the measurement cancellation/deadline signal into the approval controller.
3. A failed journal append poisoned its promise chain and could bypass final results/calls
   publication. The caller still receives the error and scheduling stays stopped, but the
   joinable chain permits finalization/recovery receipts; ledger cleanup is unconditional.
4. Mandatory pending prose judgments made the numerical win gate impossible. Before any
   live call, primary utility was explicitly scoped to A1/A2/A3/X1/X2/X3, with A4/X4
   still run and separately reported under unchanged prose gates. Automatically checked
   regression/scope failures on any task still veto a win. Same96slots, no extra spend,
   no retrospective rubric change, no invented human verdict. The [protocol](../plans/R17f.md)
   records18primary pairs per comparison and the unchanged conservative numeric thresholds.

Root reproduced the cleanliness, preview, journal and impossible-gate defects with tests
that fail against the reviewed production code and pass after repair. Additional checks
cover cancellation, final results/call preservation after an actual failed append, and
the selected LLM arm's auxiliary pairing. No optional review comment became a new issue
or nested roadmap gate. The conservative token headroom and zero-tolerance unknown-call
stop remain deliberate, disclosed limitations; a partial rerun is possible.

A single focused Codex delta check, session `01a082ff-ffe6-7313-9e5c-d6a7d46850d1`, verified
the grouped repair on `04072b1` with executable probes. All four findings passed; no full-suite
claim is attributed to that sandboxed delta. Root's build/typecheck/full suite at that head
passed **3591 tests / 4 skips / 231 files**.

## Protocol correction and injection-control verification

The invalid pilot exposed a missing original E3 test-filename instruction despite the initial
reviews. It was restored verbatim and tested over the actual provider request, failing before
the repair. Graceful cancellation/final accounting and the separate index-injection control
were included in one bounded scoped review of `4d41826a0ba064e67dead46125aa6a64e34426b6`:

- Claude Code `48c0fa45-1c76-4456-882c-33338220937e`: no material defects; actual
  build/typecheck/preflight, 24 focused runtime/injection tests and 139 neighboring cases.
- Codex `01a08311-2cb0-7743-8656-c07d932286b1`: no material defects; syntax/diff checks.
  Its sandbox denied host fixture writes; it did not claim Vitest or build execution.
- Root's combined build/typecheck/full suite: **3599 passed / 4 skipped / 232 files**.
  These verify the frozen collection/control head, not the later default-selection changes.

[Scoped-review receipt](https://github.com/agentkitai/agentrig/pull/290#issuecomment-5592593005).
The separate injection-control builder was Claude session `a77dc921-e7b3-49fb-83af-60bd6f4e7c5d`.
No conductor session is invented. [Collected results and limitations](../R17f-RESULTS.md).

## Final default/publication delta

One bounded pass per reviewer over `4d41826..8e10adc`, not another general evaluator review:

- Claude Code `fb9a645c-765b-41bf-9dd2-b4e35945e4ae`: CLEAN. Actual fixture preflight and
  changed suites passed (12 tests); independently reproduced all outcomes, medians, paired
  comparisons, tokens, mechanism counts, archive hashes and 3,236 embedded-file hashes.
- Codex `01a08757-de12-7dd0-abf1-83309b9b1544`: CLEAN. Verified source/test delta, unique
  slots, accounting/ratios, archive and embedded hashes. Its fixture preflight rejected the
  sandbox TMPDIR ancestry; no bypass or unexecuted test claim. Root/Claude supply execution.
- Root: build/typecheck pass, 85 focused tests, full **3600 passed / 4 skipped / 232 files**.
  Default regression failed before the config change. The old headless visibility assumption
  failed in the full suite and was replaced with actual default-off/explicit-on controls.

The final follow-through changes only documentation: two stale injection descriptions, exact
failure-slot wording, and delivery/review status. No new general review is needed for those
corrections. Final exact-head and post-merge CI remain mandatory and are recorded on PR #290.
