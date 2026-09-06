# R7a independent review — original findings

One Claude CLI session `ffc37138-9bc3-403f-a1c9-bed646976277`, 248,157 ms,
34 reported turns despite requested `--max-turns 24`; success/not an error.
Reviewer commands were denied approval: findings are code-traced, not an independent
executed-test receipt. No second broad review. Original result follows verbatim.

Review complete. I could not execute tests, typecheck, or the reproduction: every `pnpm` and `node -e` invocation was denied approval in this session, so all findings below are code-traced, with the exact lines cited.

## Verdict: REQUEST_CHANGES

**Finding 1 (blocking): real `schedule tick --execute` claims the occurrence and never launches a session.**
`packages/cli/src/program.ts:358-364` builds the run options from the tick command's own flags and casts the incomplete object `as RunOptions`. The tick command never registers the run command's defaulted flags, so `supervisorSoft`, `supervisorTurnsRemaining`, `dreamEverySessions` and `dreamEveryHours` arrive as `undefined`, although `RunOptions` at `packages/cli/src/run.ts:77-82` declares them required strings. `runCommand` at `packages/cli/src/run.ts:372` calls `parseSoft(undefined)`, which goes through `positiveNumber` (`run.ts:340-346`), gets `NaN`, throws, prints the error, sets `process.exitCode = 1` and returns before any agent is built. `program.ts:365` then sees the non-zero exit code and throws `scheduled run <id> failed; occurrence remains claimed`. The claim was already written at `packages/cli/src/schedule.ts:146-147`. Consequence: on a default install with no config overrides every due occurrence is consumed and lost, the tick exits non-zero, and no session ever starts. The only test of the CLI path, `packages/cli/test/schedule.test.ts:96-109`, injects a mocked `run`, so this cannot be observed by the suite. Reproduction, in a temp directory containing a `.git` marker:

```
node packages/cli/dist/index.js schedule add one "<current-UTC-minute> <current-UTC-hour> * * *" "say hi"
OPENAI_API_KEY=x node packages/cli/dist/index.js schedule tick --execute --trust -p openai --base-url http://127.0.0.1:9
# expected stderr: --supervisor-soft must be a positive number, got "undefined"
# then: scheduled run one failed; occurrence remains claimed
cat .agentrig/schedule.json   # lastClaimedMinute now set
```

Fix direction: supply the same defaults the run command has, or share the option registration, and add a test that drives `tick --execute` through the real `runCommand` with a fixture provider instead of a mocked `run`.

**Finding 2 (material): a budget-ended earlier entry silently loses every later due entry for that minute.**
`program.ts:365` throws whenever the previous run's exit code is non-zero. `run.ts:489` sets exit code 1 for any reason other than `done`, which includes `budget`, the expected outcome for a five-turn default budget. The loop in `schedule.ts:143-149` then stops, so later due entries are neither claimed nor launched, and with no catch-up their occurrence is gone. The error names only the failing entry. The contract reserves "stops further launches" for cancellation, not for a bounded run reaching its limit. Suggested fix: continue through the remaining due entries, collect outcomes, and exit non-zero at the end with a per-entry summary.

**Finding 3 (material, evidence): contract-required negative controls are not in the branch.**
`docs/plans/R7a.md:59` requires named negative controls that remove due/claim/provenance guards and fail before restoration. `docs/STATUS.md` says mutation controls are still pending. Nothing in the diff records them.

**What checks out.** The cron grammar and day-of-month/day-of-week OR semantics match the contract, with Sunday-7 and aliases rejected. Bounds on table size, entry count, ID, cron, task and flags are enforced by the zod schemas and the capped read. Symlinked `.agentrig`, table and lock paths are rejected. The lock is exclusive, never stolen, and held through session settlement. Claims are written before dispatch and earlier or repeated minutes cannot relaunch. The core change correctly treats a scheduled task as advisory project-trust context, skips the user-expansion call, emits `run.scheduled` with a schema variant and render case, and the fixture test confirms a headless first exec is denied despite blanket allow. Cancellation joins the session before releasing the lock.

**Optional polish, not blocking:**
- `program.ts:363` hard-codes the per-turn token cap at 4096, silently overriding a config `maxTokensPerTurn`. The contract does not mention this.
- `program.ts:341` uses `Number()` for flags, so `0x10` and `1e1` are accepted as 16 and 10.
- `program.ts:361` builds the sessions root with a literal slash. Use `join` for Windows.
- `--json` and `--trust` are accepted on a preview tick and ignored without a note.
- PLAN section 2.5's event list does not include `run.scheduled`.
- The scheduled session's cwd is the process cwd, not the canonical project root. This matches `run`, so it is a note only.
