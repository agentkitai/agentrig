# Independent review — sandbox network override

One read-only Claude review of frozen4052c38 against5d91ce0. Requested max24;
reported 21 turns. Session `c12dcb4b-0846-4325-92b3-37e316d462f2`, duration 110998ms,
API duration 100645ms, is_error=false. No second review or continuation.

## Original result (verbatim)

Review complete. Verdict: **approve**, no blocking findings.

**Executed commands**
- `git diff 5d91ce0..4052c38` (full diff, 10 files: 2 source lines in program.ts, 4 test files, 5 docs)
- `pnpm exec vitest run` on the five allowed files: 5 files, 106 tests passed, matching the STATUS.md count
- `pnpm typecheck`: all four packages clean
- Read-only reads and greps of program.ts, config.ts, agent-builder.ts, mcp-login.ts, otel.ts, core sandbox.ts and sandbox-providers.ts, plus the three docs. No command was denied. No edits, git mutations, agents, or network use.

**Correctness verification**
- Both `--sandbox-network` and `--no-sandbox-network` are registered on the same command, so Commander leaves the omitted default `undefined` rather than `true`. program.test.ts asserts this for run, root TUI and resume.
- `--no-sandbox-network` produces `false` with option source `cli`. The explicit-CLI filter at `packages/cli/src/config.ts:288` only drops `undefined` and `default`-sourced values, so `false` overrides user, profile and project `true`. config.test.ts exercises all four surfaces and both flag orderings.
- Every consumer treats `false` identically to omitted: `!== true` checks in otel.ts, mcp-login.ts and agent-builder.ts, and `?? false` at `packages/cli/src/agent-builder.ts:617`. `buildSandbox` emits no network grant, so Docker gets `--network none` and Seatbelt gets `(deny network*)`, while mode `none` returns the no-op provider. No runtime path changes.
- The inert net dispatch test replaces the OS provider with a fake `prepare`, so no Docker is launched, and confirms `sandbox.denied` only under the negative flag despite YOLO. The MCP login test mocks `loginMcp` and asserts the transport is never reached under the negative flag.

**Findings**
- Info, README.md:203. The prose lists run, TUI, resume and `mcp login` as the affected surfaces, but the shared option set also attaches the flag to `acp`, `web` and `mcp-serve` (program.ts:399, 407, 417). This is consistent with the positive flag's existing behavior and the plan's "shared" wording, so it is a documentation-scope note, not a defect.
- No severity findings in source or tests.

**Omitted checks**
- Fail-before evidence for the six named controls was not reproduced, since that requires checking out base sources into the working tree.
- Full test suite, `pnpm build`, Docker, Chromium and hosted CI gates were outside the allowed command set.
- docs/PLAN.md was searched for sandbox and network terms rather than read in full. It contains no sandbox-network contract, so the plan file in docs/plans is the governing spec for this item.

## Author clarification and disposition

The informational documentation-scope note is addressed: the shared option also
applies to ACP, web and MCP serving. Their existing configuration/runtime policy
behavior is unchanged. The review's “No network use” means no live/external service
use: the allowed five-file suite does include an existing local HTTP/OAuth fixture.
The new login control mocks its transport and performs no OAuth exchange. The
review searched rather than fully read PLAN; that limitation is retained above.
Author fail-before controls, required Docker full suite and Chromium are separate
verification, not attributed to the reviewer.

