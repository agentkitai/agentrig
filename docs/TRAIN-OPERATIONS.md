# Operating a release train

The [topic skill](../.agentrig/skills/topic/SKILL.md) defines authorization,
reviews, merge gates, and halts. This document describes operator monitoring;
it does not change those requirements or permission policy.

## Profile-scoped child environment (#506)

Put nonsecret tool homes in the **user** configuration, not the checkout:

```json
{
  "profiles": {
    "personal": {
      "childEnv": {
        "CODEX_HOME": "/absolute/path/to/personal-codex",
        "CLAUDE_CONFIG_DIR": "/absolute/path/to/personal-claude"
      }
    }
  }
}
```

`profiles.<name>.childEnv` is optional and zod-validated. Values are plain strings;
reviewer homes must be absolute paths. Credential-named variables are rejected;
never put secrets in this map (it is configuration, not a secret store). The selected
safe user profile overrides the launching environment; undeclared variables retain
inherited values. Project profiles never supply child environment, even when trusted.
The existing rule that ignores user state inside the project boundary still applies.

Launch with `agentrig --profile personal train /absolute/train-root`, or set each row's
`environment.profile`. The CLI applies this environment before action dispatch, so
headless run and its tool/subagent processes inherit it. Between-row train commands
(including install/build/typecheck/test) instead use a snapshot of the launcher
environment plus resolved `CODEX_HOME` and `CLAUDE_CONFIG_DIR` only. They never
receive `AGENTRIG_CHILD_PROFILE`, even when inherited by the launcher, or other
profile-only overrides. The headless run child retains the full profile-scoped
environment and selection marker. Train resolves row environment before starting
commands and again after fast-forwarding the checkout.
A private `AGENTRIG_CHILD_PROFILE` marker carries selection into nested CLI/adapters;
prefer explicit `--profile` at the operator boundary. Normal project trust remains
required to consume checkout declarations; there are no new unattended questions.

For each trusted project's declared CLI reviewer slot, train checks the resolved
`CODEX_HOME` (`codex-cli`) or `CLAUDE_CONFIG_DIR` (`claude-cli`) before launching.
Absent/blank homes fail with `REVIEWER_HOME_MISSING: reviewers:<slot>`; relative or
control-bearing homes fail with `REVIEWER_HOME_INVALID`. No fallback to a CLI's default
login is allowed. API reviewers do not require either CLI home.

Before launch, run `agentrig doctor --profile personal`. Each `reviewers:<slot>` check
executes `codex login status` or `claude auth status` under the resolved environment.
It prints only recognized visible identity (Claude email, or Codex login method when
Codex does not expose account identity) and the selected home, never raw status output
or credential files. A status failure is a failed diagnostic, not an authorization
prompt. Confirm the home/account is the intended billing account before proceeding.

## Stay available for child prompts

Follow the conductor's `subagent.spawn` events recursively into child session
logs under the configured session-store root (the personal-profile R17 run uses
`.agentrig/raw/sessions`). A live terminal, or a parent waiting on `subagent`,
does not prove work is progressing. Check at least every 30 seconds while
operating the train:

- Unresolved `permission.decision` asks and their `permission.request` inputs.
  Inspect the exact command/effects before approving a scoped request through
  the TUI; never auto-approve unknown effects or change policy to avoid prompts.
- `question.asked` without its matching `question.answered`. The current
  `QUESTION_TIMEOUT_MS` in `packages/core/src/questions.ts` is 120,000 ms;
  timeout emits `question.answered` with `outcome: "timeout"`. The 30-second
  cadence gives time to respond, but is not permission to invent an answer.
  A timed-out question is not still awaiting an answer.
- Child `session.end` and the conductor's resulting decision. Read the report;
  a terminal reason of `done` alone does not prove the roadmap row was delivered.
- Recent child activity and pending tools. A long-running test/review can be
  legitimate; inspect the job instead of treating elapsed time alone as a halt.

Use complete JSONL records only; ignore an incomplete trailing line while an
append is in flight. Do not modify canonical logs. Bind PR status and CI to the
current head and, after merging, the exact merge commit. Earlier green checks
do not validate later local edits or a new head.

An operator must remain available to service these prompts. Saving a status
script does not provide unattended monitoring or wake an assistant whose turn
has ended. An assistant operating the train must keep its monitoring turn
active until completion or an explicit handoff/blocker, rather than end its
turn with a claim that monitoring continues. If interrupted, re-check every
live child before reporting progress. Record a missed prompt honestly; do not
blame a valid permission gate for an operator's absence.

For PTY input and fixture readiness, see [TUI input protocol](TUI-SETTINGS.md#driving-the-tui-from-a-pty).

## `agentrig train <dir>` (R18c)

The command replaces the operator's `drain.sh`/`train.sh` queue loop. It is a
serial queue transport and independent landing-evidence gate, **not** a replacement
for ship/topic review, authorization or merge decisions. Those remain in skills.
Use a dedicated checkout on its configured base branch. Keep the train directory
outside that checkout (and use a proof TMPDIR outside Git ancestry per TESTING).
Normal provider/profile, project trust, explicit denies and sandbox policy apply;
the command never adds `--trust`, `--yolo` or permission grants. Set up the normal
headless run configuration beforehand; unavailable consent causes a row halt.

```sh
mkdir -p /absolute/train/queue
# Save the operator-authored JSON below as queue/001-task.json, then:
agentrig train /absolute/train
# Read-only counts, usage and coverage diagnostics (no drain or child):
agentrig train /absolute/train --status
# After the active row, stop without consuming another row:
touch /absolute/train/STOP
# Or wait between rows until PAUSE is removed (STOP takes precedence):
touch /absolute/train/PAUSE
rm /absolute/train/PAUSE
```

Each row is a strict zod-validated object (unknown fields are refused):

```json
{
  "task": "Implement the one authorized roadmap row using ship",
  "authorization": "The human's exact scoped task/merge authorization quote",
  "scope": ["packages/core/test"],
  "builderProvider": "sol",
  "environment": {
    "checkout": "/absolute/dedicated-checkout",
    "repository": "owner/repo",
    "baseBranch": "main",
    "ciWorkflows": ["CI"],
    "profile": "personal"
  }
}
```

`builderProvider` is an optional named provider entry from the active profile (not a
vendor/model id). Names are bounded to 128 lowercase letters/digits/hyphens, start
with a letter, and cannot be reserved `default`. Unknown entries fail row validation
before checkout commands; omit the field to retain the profile's configured child
default. The train forwards it as `run --builder-provider <entry>`; this documented
run-only option exposes routing data to the ship conductor, not a global provider
override. Ship owns builder/fixer dispatch; reviewers, arbiters and landers keep their
existing routing. Revalidation after fast-forward prevents stale configuration use.

Operator rule: doc/test/helper-scoped rows default to `sol`; product rows use the
profile default (omit `builderProvider`). Choose the field explicitly when preparing
the queue, rather than inferring scope in the transport. Re-check cost and quality
after ten Sol rows. This is operator policy, not an automatic scope classifier.

`profile` is optional. `environment.sessionRoot` optionally selects an absolute
session store; otherwise every row uses `<dir>/logs/sessions`. Optional
`resume: {"session":"prior-session-id","pr":123}` resumes that same session
through `run --resume`; `pr` is optional, but when present pins the returned PR.
Use the same session store as the original run. Queue text is input, not proof of
consent: ship must apply the supplied authorization's actual bounds. Scope and
authorization are forwarded verbatim as data, not converted into tool permissions.

### Directory and transition contract

- `queue/`: unique, lexically sorted `[A-Za-z0-9][A-Za-z0-9_-]*.json` rows, at most
  64 KiB each. Publish rows by atomic rename, never edit one while being consumed.
- `active/`: exactly one claimed row. A directory lock rejects concurrent drains.
- `done/`: only after the child identifies a PR, GitHub reports it merged into the
  configured base, and **every configured workflow** has a completed successful
  push run on the **exact merge commit** and base branch. Empty, skipped, pending,
  failing or mismatched CI cannot pass. The command does not wait for pending CI;
  it halts, preserving evidence for reconciliation. Choose required workflow names
  explicitly; a different green workflow is not a substitute. All matching runs
  returned by the bounded GitHub query must be green (conservative on reruns).
- `halted/`: the first failed row; no subsequent row starts. Exit code 1.
- `logs/<id>.log`: commands, stdout/stderr and retry markers. The headless child is
  given a host-owned `--output-schema` and returns final assistant JSON `{"pr":123}`.
  The host captures `message.append` plus successful `output.validated` events from
  existing `run --json` stdout and atomically writes `logs/<id>.result.json`. No
  model tool writes outside the checkout, and no permission rule is widened. Missing,
  malformed or unvalidated output halts. This receipt is a PR pointer, **not** landing proof. `logs/<id>.state.json` records progress, PR/head,
  merge commit and observed session IDs. `logs/<id>.halt.json` records machine-readable
  `row`, `phase`, `reason`, `pr`, `head`, `mergeCommit`, `sessionIds`; unavailable IDs
  are null/empty, never invented. Files in logs are operational metadata, not session
  JSONL; canonical session logs remain owned by the existing run/session store.

The prompt serializes the entire row as one JSON value: only its `authorization`
field is the verbatim human quote, not a heading forged inside task text. Each
invocation supplies a fresh host-generated `agentrig-train-row:<UUID>` line for the
PR body. Unless the operator explicitly pinned that PR in `resume.pr`, the landing
gate requires this exact line and rejects merges already in the starting base.
It freshly fetches the configured base and checks merge ancestry; missing objects,
fetch failures and ancestry errors halt. Pinned resumes still require the configured
repository/base, reachable merge commit and exact-merge green CI.

All queue entries must have valid `.json` row names; an unexpected extension is an
error, never silently skipped as an empty queue. Active recovery uses the same
basename validation: invalid entries (including `.DS_Store` and editor files)
are left untouched and skipped, never renamed or converted to halt evidence.
`train.status.invalidEntries` lists invalid names with their folder, including
malformed `.json` names. Counts include these entries; they are not valid rows.
Usage refuses duplicate row stems across queue/active/done/halted, even across
different checkouts, rather than combining or overwriting their totals. Atomic metadata writes use fresh
exclusive-create temporary names, so an interrupted stale `.tmp` cannot prevent a
recovery halt record. Stale evidence is left intact.

After each fast-forward, train resolves the checkout's project checks using the row's
optional profile. A declared `testTimeout` on its bare `pnpm test` entry supplies the
bounded higher per-test Vitest budget (AgentRig: 15000ms; zod range 1–120000ms).
The effective argv is `pnpm test --testTimeout=15000`; its validation command log
records both argv and numeric `testTimeout`. Without that declaration, argv and log
shape stay unchanged. Duplicate budgeted `pnpm test` entries are ambiguous and halt;
invalid project config also halts before validation runs. This configures the fixed
train validation suite, not arbitrary project commands or a shell execution timeout.
Budgeted/composite/otherwise argument-bearing suites are **not** eligible for the
exact-command isolated retry below, preserving #501's conservative gate.

Before **each** row, including resumes, validate repository root, clean checkout,
base branch and exact GitHub origin; fetch, fast-forward only, and refuse a locally
advanced base. Then run `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm typecheck`, `pnpm test`. Each step gets at most one retry for narrowly
classified network infrastructure errors (ECONNRESET/EAI_AGAIN/ETIMEDOUT, DNS or
remote disconnect), not assertions/compiler failures. A failed `pnpm test` with a
complete Vitest default report containing **only** `Test timed out in 5000ms.`
failures qualifies separately: rerun each reported test file, sequentially and once,
using `pnpm exec vitest run --no-file-parallelism <file>`. Never rerun the whole
suite for these timeouts or rerun passed files. A failed isolated retry halts in
checkout; mixed assertions, malformed/incomplete reports, unsafe file names,
unhandled errors and other timeout budgets fail closed. Original output and each
isolated argv remain in the row log. Never retry the row itself.
Git and pnpm must be available; landing verification uses authenticated `gh`.
Children inherit the operator's environment, without git-ai PATH injection and with
`GIT_TRACE2_EVENT=0`. The command uses argv spawning, not shell interpolation.

Train resolves named profiles against safely loaded user config and trusted project
config, like `run --profile`; profiles need not be duplicated in project config.
Train test-budget resolution recognizes user-only profile names too, while keeping
check declarations project-owned.

`train --status` validates queued row schemas, profile/reviewer environments and test
budgets read-only, reporting failures in `invalidEntries`. Dispatch validates only the selected first queued row before claiming it; later queue
errors and non-row filenames in `done/` or `halted/` remain informational status
diagnostics, not dispatch gates. An invalid selected row is never skipped: the JSON remains in `queue/`, no child runs and no
consumed halt record is created. Fix the config or queued row and retry. Failures
after checkout starts still move the claimed row to `halted/`.

A JSON `train.status` is printed after every completed or halted row and by the
read-only `agentrig train <dir> --status`. It includes `queue`, `active`, `done`,
`halted`, `invalidEntries`, `usage` and `pricingNote`; accounting failures yield
`usage: null` plus `usageError`, never misleading zero totals. Each `usage` row has
`row`, `totals`, `sessions` (with per-session `totals`, effective `builderProvider`, and provider/model `models`),
and `coverageWarnings`. `builderProvider` is the actual named entry captured at
subagent creation, for every child role (not an assertion that it was a builder).
Root/historical/unknown or conflicting entries are null, never copied from row intent.
Children with no ledger calls remain visible with zero calls and unknown cost.
The ship PR child inventory records the same effective field and any row override.
Totals expose `calls`, `input`, `output`, `cacheRead`,
`cacheWrite`, `estimatedMicros`, `unpricedCalls` and `incompleteCalls`. Raw token
counts include unpriced calls; `estimatedMicros` covers only the priced subset at
historical configured rates, is not provider billing, and is null (not zero cost)
when nothing is priced. ChatGPT-login calls remain unpriced.

Coverage warnings distinguish session-scoped ledger gaps and ambiguous claims
(excluded from every claiming row), missing/unreadable spawn logs, valid-prefix
use for torn tails, and checkout-local `ledger-wide` diagnostics. Separate warning
entries identify gaps without a session, gaps with an **unclaimed** session, and
calls without session attribution. They do not assign unknown spend to a row and
do not leak warnings across checkouts. Retain ledger and session roots to preserve
ancestry/coverage; warning-free known totals are not proof of provider billing.
`agentrig usage --row <id> --train-dir <dir>` exposes the same row accounting.

`train.end` reports empty, halted or stopped. STOP/PAUSE are checked
**between rows**, never kill an active child or interrupt a merge. Empty and STOP
exit successfully. Removing STOP permits another invocation. PAUSE polls once per
second and is interruptible at process level; it does not consume pending rows.

After a process crash, do not blindly remove `.lock`: reconcile live children and
landing evidence first. Once no drain is live, remove the stale lock and rerun; an
orphaned active row is moved to halted with phase `recovery`, never executed again.
To continue a halted task, retain its evidence and enqueue a **new unique row id**
with explicit resume pointers and unchanged authorization bounds. Existing done or
halted row ids and stale result receipts are never reused. Directory layout/name/
lock errors are command errors before execution, not evidence of a landed row.

Reviewer adapter preflight: missing homes and invalid profiles exit 64 before launch and
do not consume the single exit-2 retry. Fix configuration before re-dispatch. Review
headings include transport model and JSON-quoted resolved home in the canonical suffix.
