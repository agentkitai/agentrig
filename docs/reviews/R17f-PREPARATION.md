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

A single focused independent delta check follows this grouped repair; its receipt will be
recorded before collection. No repeated general review is required for delivery metadata.
