# Running the tests

Most Vitest imports resolve workspace packages to source, but the full suite also exercises built
CLI/evaluator artifacts. Run `pnpm install --frozen-lockfile` and `pnpm build` before the full suite
or evaluator tests; source-only focused tests such as `command-outcome` need no build.

```sh
pnpm test                  # fixture preflight, then the whole suite
pnpm test:preflight        # the preflight alone, printing what it checked
pnpm exec vitest run packages/core/test/command-outcome.test.ts
pnpm exec vitest run --config vitest.windows.config.ts   # the Windows CI include list
pnpm exec vitest run --config vitest.web.config.ts       # the Chromium lane
```

The Windows include-list lane uses two file workers and 30-second default test and
hook budgets for real-process/filesystem integrations, including evalset setup and
teardown. Explicit per-test and per-hook deadlines still apply; shared Linux/macOS
defaults and production operation deadlines do not move.
The real-process memory-conservation fixture opts into bounded 20-second lock
waits rather than testing the production five-second default under unrelated suite
load. Both writer processes still overlap and must demonstrate actual lock ownership.
Neither change skips assertions or replaces the separately measured feel budgets.

`vitest.config.ts` pins `root` to its own directory, so the repository-relative `include` resolves
the same way from anywhere. A workspace-local run works without `--root`:

```sh
pnpm --filter @agentkitai/agentrig-cli exec vitest run packages/core/test/command-outcome.test.ts
```

Use repository-relative paths to avoid ambiguous matches; Vitest's substring filter also accepts
`test/command-outcome.test.ts`. The older explicit `--root ../..` invocation remains valid, and
`vitest.windows.config.ts` and `vitest.web.config.ts` spread the base config, so they inherit the
same root. Before this was pinned, a workspace-local run exited 1 with `No test files found`
([feel #245](https://github.com/agentkitai/agentrig/issues/245)).

Vitest sets `GIT_TRACE2_EVENT=0` in the test process environment (including the inherited
Windows/web configs). Product Git children using `gitEnvironment()` also reset it after
stripping inherited `GIT_*` variables, so checkpointer, checkpoint-undo and subagent-worktree
Git calls are isolated from host trace2 event targets. Caller-built environments omitting the setting
are not guaranteed isolated. The override disables host `trace2.eventTarget` hooks such as
git-ai, which can write `refs/notes/ai` in fixture repositories and race teardown (`ENOTEMPTY`).
It does not disable `trace2.normalTarget` or `trace2.perfTarget`.
This is separate from fixture ancestry and does not change the preflight check.

## Suite-wide project-store guard

`test/setup-no-ci.ts` takes read-only recursive inventories before and after every test
file of `.agentrig/raw/sessions` and `.agentrig/wiki` under the repository root and each
of `packages/cli`, `packages/core`, `packages/memory`, and `packages/supervisor`. This
catches tests that accidentally use checkout defaults, including an empty wiki directory.
Inventories include directories (even empty ones), file content hashes, symlink targets
without following links, and special entries. No session content is printed or modified.
Mid-scan disappearance is recorded at the affected path as `removed-during-inventory`
instead of an opaque ENOENT; an initially absent root is normal. Other I/O errors still fail.
The recursive inventory regression also runs in the Windows include-list lane.

The guard proves before/after equality, not ownership of writes, and is not a continuous
filesystem monitor. Concurrent legitimate checkout sessions or memory maintenance can
change an inventoried store and fail unrelated test files; an append or removal during
inventory may likewise fail. Do not disable the guard or delete genuine stores to get green.
Run tests in a separate clean checkout/worktree with no agent writing those stores, or
finish/pause the legitimate writer first. For a real test leak, give that test explicit
session **and memory** paths in its owned `mkdtemp` fixture outside Git ancestry, with
owner-scoped teardown; do not rely on `--root` alone to relocate memory. Preserve failed
inventory evidence and investigate paths before removing anything. This guard is separate
from the ancestry preflight below and neither bypasses nor repairs it.

## The fixture preflight

`test/fixture-preflight.mjs` runs before the suite in `pnpm test` and is silent unless it finds
something. It looks for a `.git` file, directory or symlink beside the effective temporary
directory (`TMPDIR`, or the platform default) and each of its lexical and canonical ancestors,
including ancestors hidden behind a symlinked temp path, and fails with an
explanation instead of letting the suite fail 120 tests deep. A marker it cannot read counts as
present: reporting an `EACCES` probe as "absent" would hide exactly the case it exists to catch.

Most fixtures are built under the temporary directory and assert they are **not** inside a
repository. Project-root discovery walks ancestors for `.git`, so any marker above the temporary
directory captures every fixture below it and trust-root, checkpoint and other non-Git assertions
fail for reasons that have nothing to do with the code under test.

The preflight does not repair anything, and nothing in the product changes because of it:

- It never deletes a marker. Under the sandbox below the markers are read-only mounts that the
  session does not own; above a real repository, moving it is the operator's decision.
- It offers no bypass flag and skips no test. A red preflight means the run has to move to another
  environment, not that the suite is adjusted to tolerate this one.
- Discovery is not being taught to ignore `.git`. Fail-closed trust discovery is the correct
  behavior; the environment is what is wrong.

## Known sandbox limitation

In the controlled Codex `workspace-write` experiment, empty, mode-0555 `.git` directories appeared
at `/tmp/.git` and the private `$TMPDIR/.git`; `/proc/self/mountinfo` showed read-only tmpfs mounts.
The same probe on the host reported `ENOENT` for those two paths. This does not claim a real
checkout's Git metadata is absent or replaced by an empty directory. Moving `TMPDIR` did not escape it —
the new writable root receives its own synthetic marker. The reproduction and evidence are in
[feel #237](https://github.com/agentkitai/agentrig/issues/237#issuecomment-5588263750); the working
diagnostic was `codex sandbox -c 'sandbox_mode="workspace-write"' -- node <probe>` (the current CLI
has no `linux` subcommand).

In that view the preflight fails immediately, and it is correct to: the outside-Git fixtures cannot
pass there. It is a property of that filesystem view, not a product regression, and it is **not**
an identified creator of any historically observed `/tmp/.git` on a host. The mechanism explains
the reviewer environments that reproduce it; the original cause and owner of the failures in #237,
#271 and PR #269 remain unknown, and neither the preflight nor this document reproduces or fixes
those historical runs. The preflight is a point-in-time check, not a guarantee that ancestry
cannot change during a run. A later host check cannot establish what another process or earlier
filesystem namespace saw. In particular, an ancestor `.agentrig` directory alone is **not** a
project-root marker: `canonicalProjectRoot` in `packages/cli/src/trust.ts` checks `.git` only.
The earlier `.agentrig`-only explanation is superseded by the controlled evidence linked above.

## Reviewing code is not running the suite

A session that cannot get a clean preflight can still review code, and should say exactly that:

- Report the preflight failure and the environment, and hand actual execution to a runner outside
  the sandbox — the host shell, another machine, or CI.
- Record which environment produced which result. "42/45 checkpoint tests, three outside-Git
  fixtures failing, under a workspace-write sandbox" and "3473 passing on the host" are two
  separate facts about the same head; neither one converts the other into a pass or a failure.
- A review that did not run the suite says so. Someone else's passing run does not retire that
  limitation, and a passing run elsewhere does not erase an observed failure.

## Declared project checks

The shipping skills consume **project data**, not a built-in JavaScript workflow. Declare
`checks` in the repository's `.agentrig/config.json`. `profiles.<name>.checks` replaces the
whole base declaration (including the ordered steps). This uses the existing strict zod
config boundary; duplicate step names, unknown fields, blank commands/names and unsupported
parser identifiers are rejected. Names need not be build/test/typecheck. `bootstrap` and
`preflight` are reserved step names after trimming, even if preflight is absent. At most 64
steps are allowed; names are limited to 256 UTF-16 code units, commands (including bootstrap
and preflight) to 4096 before trimming. Fields are single-line: C0/C1 controls (including tabs,
newlines and ESC), Unicode line/paragraph separators and bidi formatting U+202A–202E,
U+2066–2069 are rejected before trimming. Ordinary shell quotes/operators remain allowed;
this is receipt/display hygiene, not shell safety or authorization. Checks are file declaration
metadata only: normal resolved runtime/evaluation settings never carry them.

AgentRig's worked example (also committed as its project config):

```json
{
  "checks": {
    "bootstrap": "pnpm install --frozen-lockfile",
    "preflight": "pnpm test:preflight",
    "steps": [
      { "name": "build", "command": "pnpm build" },
      { "name": "test", "command": "pnpm test", "countsParser": "vitest" },
      { "name": "typecheck", "command": "pnpm typecheck" }
    ]
  }
}
```

Python can declare bootstrap `python -m pip install -e .` and a step named `unit` running
`python -m pytest` with `countsParser: "pytest"`; Rust can declare `cargo fetch` and
`cargo test` (`cargo-test`); Go can declare `go mod download` and `go test ./...` (`go-test`).
The optional countsParser is a metadata hint to the caller, not executable code or an
implemented output parser here. Unknown/unavailable counts are N/A; only exit codes judge
success. No parser result can turn a nonzero exit green.

Read-only module boundary for skills/supervisor integrations: import `resolveProjectChecks`
from `packages/cli/dist/project-checks.js` after building AgentRig (source:
`packages/cli/src/project-checks.ts`), then call `await resolveProjectChecks(projectRoot, profile?)`.
The explicit root may be any repository, including outside this monorepo. This only reads and
validates that project's config; it does not search home config, infer commands, spawn a shell,
or implement a workflow. A missing declaration returns undefined (stop/request declaration),
not an empty success. A missing file returns undefined even with a selected profile; an existing file with an unknown profile rejects. Invalid config rejects. The returned object is declaration data,
not permission to execute it: display source/root, selected profile and commands and retain
normal project trust, permission prompts and sandbox checks.

Zero, one or many named steps are supported; receipts follow the resolved declaration.
An explicit `steps: []` is valid and means **NO local checks**, including bootstrap and
preflight, even if declared. Consumers must branch on empty steps **before** executing anything
(the resolver returns bootstrap and preflight unchanged as inert declaration data).
Record `declared checks: none`; landing still needs exact-head CI plus human merge authorization.
Do not claim local green or waive missing CI. For nonempty steps, bootstrap, optional preflight,
and each named step run in order, stopping on nonzero, recording name, command, exit code,
UTC start/end, counts (or N/A), head and runner. The independent conductor supplies GREEN
same-head receipts **before** launching declared reviewer slots. Reviewers inspect code and
targeted mutants, not a duplicate full suite. Resolve both checks and slots at the exact PR
head; `topic` §2 step 4 and [shipping policy §1](SHIPPING-WORKFLOW.md#1-ci-and-review-are-independent-tracks)
define the common preparation. PRs record the resolved bootstrap, optional preflight and
ordered named checks (or `declared checks: none`), with exits, times and counts, plus results
for each declared reviewer slot. Zero reviewer slots require `External review: none declared`:
no reviewer worktrees or jobs, but declared checks, exact-head CI and human merge authorization
still gate landing. One slot runs once; two slots run independently in parallel.

`packages/cli/test/project-checks.test.ts` executes a tiny generated external fixture using
this resolver in the test itself. There is no CLI workflow runner.

## Skill-text instruction contracts

All tests under `packages/core/test` and `packages/cli/test` reading repository
`SKILL.md` instructions use `test/skill-text.ts` (`readSkillText`). It normalizes
CRLF (and lone CR) to LF before substring/regex contracts run. Non-skill linked
documents are read unchanged. The enforcement instruction-contract test scans
both test trees for direct filesystem skill reads, including generic wrappers.

`.gitattributes` pins `.agentrig/skills/**/*.md` to `text eol=lf` to make normal checkouts
consistent. This is defense in depth, not a substitute for loader normalization:
external copies and existing checkouts may still contain CRLF. Windows editors must support LF
for repository skill Markdown; CRLF-only Windows tooling should operate on an external copy,
not rewrite the tracked files. Non-Markdown assets keep normal Git/editor line-ending policy.
Only repository skills paths are normalized: generated SKILL.md fixtures retain raw-byte
reads/assertions so line-ending-only rewrites remain observable.

Before every push touching instruction-contract or skill-text tests, copy the
**entire** `.agentrig/skills` tree beneath the proof `TMPDIR` outside Git ancestry,
normalize LF then convert text to CRLF, and set `AGENTRIG_TEST_SKILLS_ROOT` to that
copy when rerunning every touched instruction-contract/skill-text test file. The
loader treats a present-empty override as an error and validates that every repository skills
file exists in the override tree before reading. Missing or incomplete overrides fail closed
without checkout fallback. Record start/end timestamps,
exact commands, exits and test counts beside the declared check receipts in the PR.
Remove only the owned proof copy after the pushed handoff is recorded.
