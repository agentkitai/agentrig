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

The Windows include-list lane uses two file workers and a 30-second default test
budget for real-process/filesystem integrations. Explicit per-test deadlines still
apply; shared Linux/macOS defaults and production operation deadlines do not move.
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
