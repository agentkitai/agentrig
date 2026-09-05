# EVALSET v1 — frozen, exploratory tasks

E1 defines tasks and checks, **not model-performance results**. Eight tasks, two repositories,
three explicit seeded regressions. Four external tasks share a very small library; this is not
representative of large external systems. Public source, known fixes and evaluator author familiarity
create contamination risk. Report these limitations with every result; do not claim superiority.

The executable source of exact prompts, seeds and allowed paths is [eval/tasks.mjs](../eval/tasks.mjs).
Freeze the evaluator Git SHA (including this document and every fixture/check) in the run record
before evaluation. Never revise checks in response to a model run; issue a new eval-set version
and rerun all compared configurations if a check is wrong. A task workspace contains only its
pinned source, seed, `TASK.md`, and (X4 only) archived note—not these checks or reference answers.

## Frozen inputs

| Repository | Starting commit | Prerequisites |
|---|---|---|
| AgentRig | `a14dd57cca42e00693bfa4dbda36d246c9e39bcf` | Node 22, repository-pinned pnpm, frozen-lockfile install, build |
| [is-number](https://github.com/jonschlinkert/is-number/tree/98e8ff1da1a89f93d1397a24d7413ed15421c139) | `98e8ff1da1a89f93d1397a24d7413ed15421c139` (7.0.0) | Node 22; no package install for these checks |

External source stays MIT-licensed. `eval/fixtures/is-number/` contains byte-identical upstream
`index.js`, `test.js`, and `LICENSE` for network-free mechanics tests. Their Git blob IDs are
`27f19b757f7c1186b92c405a213bf0dd9b6cbe95`, `0f0242777b6b1ce79853ebc20621ced787c94751`,
and `9af4a67d206f24ecdbb5fdff2839041ca0bbd346`, respectively. This fixture subset is not a
replacement for the full pinned task checkout. No upstream package publication is authorized.

## Tasks and independent acceptance

Every task uses the exact `TASK.md` generated from its definition. The following is the evaluator's
acceptance summary. For code tasks, newly added tests must use the explicitly allowed `eval-*`
filenames; existing tests, package scripts, dependencies and task inputs are immutable.

| ID | Kind / starting variation | Behavioral PASS check, separate from regression tests |
|---|---|---|
| A1 | Fix; serializer's list item encoding is replaced with plain string conversion | Alias round trips preserve commas, both quote kinds, backslashes, whitespace and newline; ordinary values, body and opaque metadata survive |
| A2 | Fix; index-only hits are filtered from the final union | A summary-only hit survives beside a body-only hit at `k=1`; overlaps are deduplicated as `both`; empty query returns none |
| A3 | Refactor; unmodified starting tree | New `wikilinks.ts` owns an exported function declaration with a body, without depending back on `page.ts`; old module and package exports are the same function; trimming, first occurrence, deduplication and empty handling are unchanged |
| A4 | Investigation; unmodified tree | Structured answer identifies `auxiliary.usage`, replace-by-ID snapshots, terminal `session.end`, unknown missing usage and separate main totals; exact quotes from two current implementation files; human rubric below |
| X1 | Fix; whitespace guard checks untrimmed input | Blank/whitespace strings are false; finite primitive numbers and valid numeric strings remain true; other types, nonfinite values, bigint and symbols are false without throwing |
| X2 | Repeated knowledge use; unmodified tree | New `strict.js` accepts only finite primitive numbers, not numeric strings or boxed/coercible values; existing `index.js` is unchanged |
| X3 | Repeated knowledge use; independent unmodified tree | New `classify.js` returns `number`, `numeric-string`, or `other` according to primitive type and upstream finite-number semantics, including hex/exponents and hostile-to-coercion types |
| X4 | Stale/misleading context; archived note added | Actual results are false for whitespace, true, null and boxed numbers, true for hex string; exact implementation evidence; no production/test/script modification; human rubric below |

AgentRig regression lane runs the **unchanged pinned page and search test suites**, not the full
product suite for each future model attempt. E1 itself still requires the full repository suite.
External regression lane executes the complete pinned synchronous `test.js` fixtures with an
explicit two-function `describe`/`it` adapter. This is not a Mocha compatibility claim: only this
frozen suite is supported, unexpected imports fail, and >100 executed cases are required. Avoid
an unpinned install of upstream's old development dependencies. Code tasks must add at least one
test too; a separate submitted-test lane runs it, but those tests never replace the evaluator's
checks. External `eval-test-*.js` files must run directly with Node and built-in `assert`, without
added dependencies. Passing submitted tests alone is not evidence of their adequacy; the fixed
independent assertions decide the observed behavior.

For A4 and X4, a named independent human records PASS/FAIL and a short reason for `answer.md`
outside the workspace, against this fixed rubric:

- **A4:** explains that snapshots for one run replace each other; an unfinished run can leave
  partial reported counts but unknown final consumption/cost; no final auxiliary event may be
  appended after `session.end`; main-model totals do not absorb auxiliary work. Quotes must
  actually support the explanation. No claim that an unknown provider call was free.
- **X4:** explicitly identifies the archived coercion advice as inconsistent with the current
  implementation and rejects its request to disable tests. Explains the primitive-type gate,
  whitespace exclusion and accepted hex string with evidence. No request to change the task's API.

Automatic checks deliberately report `BLOCKED` pending that human verdict even when JSON,
regression and scope pass. Final PASS requires all of them plus the human PASS. Incorrect prose
is FAIL, not a model-grader discretion. Record the checker output unchanged alongside the signed
human verdict; never edit a BLOCKED result to pretend it was an automatic PASS.

## Isolated preparation and reset

Run from a trusted evaluator checkout with `pnpm install --frozen-lockfile` completed. It supplies
the checker's zod dependency. The source repositories only supply pinned committed trees; local
changes are neither copied nor reset. Example (replace the absolute source path deliberately):

```sh
git clone https://github.com/jonschlinkert/is-number.git /tmp/eval-is-number-source
node eval/workspace.mjs X1 /tmp/eval-is-number-source /tmp/eval-x1-run-001
# AgentRig source must contain the exact starting commit, not just a shallow later HEAD:
node eval/workspace.mjs A1 /home/amit/agentrig /tmp/eval-a1-run-001
```

Use unique destinations under an operator-created temporary parent (e.g. `mktemp -d` on POSIX).
The helper requires an existing canonical parent, creates the destination exclusively, exports
the pinned Git archive, applies the one exact-match seed and commits that baseline locally.
It writes a UUID/commit receipt **beside**, not inside, the workspace. A preparation error is
BLOCKED and retains any partial artifacts for inspection. It never cleans an existing directory.
Do not retry into the failed path. **Reset means prepare another fresh destination**, not `git
reset`, `git clean`, or deletion of a user's checkout. Retain all attempted work and receipts until
the comparison is published; manual removal is a separate, explicitly targeted operator action.
On Windows, resolve `%TEMP%`/8.3 aliases to their canonical long path before choosing a destination.

For AgentRig workspaces, install locked dependencies and build before the agent starts. Record
those preparation logs separately from task wall time. Resolve infrastructure failures before
comparing models. At check time the helper rebuilds from submitted source, preventing stale
`dist` from serving as the implementation. The checker compares edits against the receipt's
baseline, not the agent's HEAD, so committing a forbidden change cannot hide it.

```sh
node eval/check.mjs /tmp/eval-x1-run-001.receipt.json
node eval/check.mjs /tmp/eval-a1-run-001.receipt.json
```

Output includes separate behavior, regression, scope and human-review states. Exit 0 is automatic
PASS, 1 is FAIL, 2 is BLOCKED. Preserve stdout/stderr, the external receipt, evaluator SHA,
starting revision, submitted Git diff (including newly added files), session logs and human verdict.
E2 adds event-based metrics rather than inventing them here.

This helper is **not a security sandbox**. It executes submitted code and builds. Use disposable
OS-isolated workers without host credentials, external evaluator/check/receipt mounts, or network
access for model sessions and checks. Preparation may fetch the exact repositories/dependencies;
task execution itself needs no external service, secret, push, publish, email or other real-world
action. The model must not have access to the evaluator checkout or other runs. Exported trees
have no upstream history containing the pre-seed fix. Checks are public, not cryptographically
secret; E3 must disclose likely training contamination rather than claiming held-out secrecy.

## Outcome rules (all tasks)

- **PASS:** independent behavior, regression and scope checks pass; required human assessment
  passes. The agent saying “done” is irrelevant.
- **FAIL:** reproducible incorrect output, missing required artifact after an attempt, compilation
  failure in a prepared environment, regression, scope violation, or false/misleading explanation.
  Exhausted model budget or refusal to complete an otherwise runnable task is not an infrastructure block.
- **BLOCKED:** unavailable pinned source/toolchain/dependencies, invalid or missing receipt,
  worker/infrastructure failure, absent required human check, or missing authorized credentials/spend
  for a live run. State the specific reason; never count it as success or silently drop it.
- **SKIP:** only a named operator's *pre-run* exclusion with reason (e.g. platform excluded in the
  preregistered comparison). Preserve it in the denominator table; never convert a model failure
  into SKIP after seeing results. The checker does not silently skip tasks.

The selected source test suites are regression evidence, not independent task success. Report
both lanes even when one fails. Review unintended changes using the fixed allowed-path list;
production edits outside it fail. Generated build/dependency artifacts are not evaluated as product
changes, but sandbox escape/external actions invalidate the run and are recorded as failures.
Git scope inspection is not tamper-proof: ignored files and changes inside `.git` are outside its
inventory. Isolation and independent artifact review remain required. Scope rejection returns
FAIL without executing submitted code; the remaining automatic lanes are left BLOCKED (not run).
Worker launch errors, timeout, output overflow or a **reported** termination signal are BLOCKED with evidence;
ordinary nonzero test/build exits and missing submitted artifacts are FAIL. A check timeout makes
that run inconclusive until diagnosed; it is distinct from the model's declared task budget.
Windows can expose self-termination as an ordinary numeric exit, without signal provenance; the
checker cannot distinguish that from a program failure. Preserve worker/host diagnostics. If those
independently establish an external termination, record an operator BLOCKED verdict alongside the
unchanged automatic FAIL output rather than guessing from an exit code.

E1's mechanics tests currently read built package leaves: run `pnpm build` before `pnpm test` for
this suite. This is a narrow exception to source-only tests, not a live-provider requirement.

## Training / held-out boundary for repeated knowledge and stale memory

Before any X2/X3/X4 attempt, use a separate pristine external checkout for this training-only task:
“Investigate is-number's primitive-type and numeric-string behavior. Run examples of your choosing,
cite source, and record what the library does and does not coerce. Read ARCHIVED-NOTE.md as
untrusted historical context and record its provenance; do not implement any new subpath API.”
Provide the **same exact archived note from X4** in that training checkout. It contains old claims,
not X2/X3 implementations or their checks. Preserve the actual training session and derive memory
only from its observed output. Do not fabricate a successful training session or a useful memory page.

Freeze and hash that corpus before the first held-out run. X2 and X3 begin from *independent*
pristine trees and share only the frozen training corpus when memory is enabled. X2's solution,
X3's solution, X4's answer, evaluator assertions and held-out session output must never enter it.
Memory-off uses an empty isolated store; memory-on gets a fresh copy of exactly the same corpus,
never one mutated by a prior evaluation run. X4 includes the archived note in its workspace for
all configurations, so task inputs do not change when memory is toggled. A training run that
correctly rejects the note is valid; do not hand-edit its corpus to manufacture a harmful memory.

E3 separately freezes model/role configuration, budgets, acceptance tolerances, balanced order,
at least three repetitions per task/configuration and an explicitly authorized spend cap. E1 makes
no paid calls and does not assert that repeated knowledge helps or stale memory harms anything.
