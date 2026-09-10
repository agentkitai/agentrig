# Ordinary session flow — direct answers, bounded maintenance, safe recovery

User authorization (2026-09-10): “ok. go ahead and handle it”, following the
read-only query session `b87bf90b`. The user should not select query/coding modes
or disable children at startup. This is one bounded corrective delivery, not a
new feature band or another general roadmap sweep.

## Observed failure

The answer's final turn ended at 1789019002168; session.end followed at 1789019302256:
300,088 ms later. The user's terminal reported 20 ingest calls, 45,001 reported tokens,
one unknown-usage call, overall timeout 300,000 ms and local writes not-started.
Those maintenance numbers are console evidence; they are not fabricated canonical
auxiliary events in the raw log. The attempted child was approved, then refused
by the retained shared checkpoint lock before dispatch.

## Contract

- Keep subagent capability available. Default prompt and tool description prefer
  direct straightforward explanations/evidence gathering, delegating only a concrete
  bounded task when context isolation or independent parallel work warrants the cost.
  This is model guidance, not a keyword classifier or guarantee of model judgment.
  Child permission, checkpoints and inherited authority stay unchanged.
- Automatic CLI session-end ingestion uses a local bounded latest-run eligibility
  check and a 30s/15s-per-call/4-call default budget. Read-only successful query runs
  can defer with a visible reason and explicit manual-capture path. Unknown/failed
  dispatched work remains eligible. Eligibility is a spending heuristic, never
  permission or proof that a conversation contains no valuable lesson.
  Explicit maintenance limits still override; manual ingest and SDK hook defaults
  retain full capture behavior. No raw logs erased, no partial transcript silently
  treated as complete, no model call merely to decide whether to ingest.
- Runtime emits additive `session.finishing` after model work/orphan settlement and
  snapshot, before session-end hooks. It carries the actual stop reason and is not
  tool/observer-emittable. CLI announces finishing maintenance; TUI displays a
  maintenance timer but remains busy until owned cleanup really settles. Aborted,
  failed and budget-stopped work is not labeled a completed answer. `session.end`
  remains final; there is no detached background writer or early new-turn admission.
- Checkpoint locks gain bounded diagnostic ownership evidence and explicit recovery,
  with identity checks and preserved artifacts, never age-based stealing. Legacy
  unknown-owner recovery requires explicit operator acknowledgment and quiescence.
  See the dedicated recovery documentation and [#295](https://github.com/agentkitai/agentrig/issues/295).

## Verification and delivery

Use real provider-request assembly tests for delegation guidance and unchanged
child authorization, actual held session-end hook/UI lifecycle tests for status,
automatic-ingest positive/negative/budget/resume controls, and isolated Git
acquire/edit/seal/release/recovery controls. Run fail-before or targeted restored
mutants for each behavior, full build/tests/typecheck, one independent Claude/Codex
review pair with focused repairs if needed, then exact-head and post-merge CI.

The lifecycle trace goldens deliberately gain the new event and corresponding
sequence shifts; they do not filter it out to hide an event-contract change.
Local scripted checks cannot prove a live model will always delegate wisely.
Real lock recovery must wait for the user's live AgentRig terminal and other
repository writers to stop; no user process is killed or lock removed silently.

Builder: Codex/operator and scoped helpers outside AgentRig. No retroactive R17a
dogfood or successful real-lock recovery claim is implied by implementation tests.
Final receipts and live-validation limits belong on the delivery PR.
