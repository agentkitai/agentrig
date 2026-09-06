# R7b independent review

One bounded Claude review, session `4233ca26-0197-4ec7-bc34-62674ce0f8d0`,
152,006 ms, 20 reported turns (24 requested), no error. Original response below.
No material findings; optional render coverage is added, remaining polish is at the roadmap end.

## Original response (verbatim)

**Verdict: APPROVE.** No material contract defects found in the uncommitted R7b diff. Findings below are optional polish.

**Checks executed**
- Read CLAUDE.md, docs/PLAN.md, docs/plans/R7b.md, the full diff against origin/main, and all of `schedule.ts`, `agent-builder.ts`, `run.ts`, the tick action in `program.ts`, and `heartbeat.test.ts`.
- `pnpm exec vitest run packages/cli/test/heartbeat.test.ts packages/cli/test/schedule.test.ts`: 28 passed, 0 failed.
- `pnpm typecheck`: all four packages clean.
- No full suite, no agents, no edits, no network, no provider calls. No commands were denied.

**Contract checks confirmed against source**
- Preview never claims or loads config: `program.ts:353` calls tick without an executor, and `schedule.ts:192` only takes the lock when an executor exists. Malformed config in preview is covered by the third test.
- Fallback only when no cron matches, including already-claimed entries: `schedule.ts:176` tests `cronDue` over every entry, not the `due` subset. The first test exercises the repeated-tick case.
- One heartbeat per UTC minute, claim written before launch, failed launch retains claim, abort checked before claim: `schedule.ts:177-183`, covered by tests 2 and 7.
- Bounds: 4096-byte cap with fatal UTF-8 decode, regular-file and realpath checks, symlink refusal (`schedule.ts:105-117`). Turn bound validated 1 to 50 at the config layer (`config.ts:114`) and again in tick (`schedule.ts:166`). Empty checklist forces maxTurns 1, tokens 10,000, minutes 5 (`agent-builder.ts:428`).
- Real builder profile: `buildAgent` applies `heartbeatBuildOptions` itself (`agent-builder.ts:432`), so the suppression is not CLI-only. Empty profile yields an actually empty registry (`agent-builder.ts:589`); extra hooks dropped (`agent-builder.ts:525`); memory, MCP, extensions, skills, packages, subagents, checkpoints, ingest, dream, repo map all forced off; runCommand additionally forces the supervisor off (`run.ts:371`). Fabricated tool call hits the unknown-tool path in `tool-execution.ts:198` with `ok: false`, and the end-to-end test confirms one request, no artifacts, no sentinel write.
- Provenance: additive optional `source` on `run.scheduled` (`events.ts:192`), emitted in `agent.ts:463`, rendered in `render.ts:72`. Scheduled task keeps advisory context and `trust: "project"`, so checklist prose cannot mint consent; the nonempty test shows bash denied twice even under configured yolo.
- Config cannot inject the profile: `ConfigValuesSchema` is strict and has no `heartbeat` key.

**Optional polish (non-blocking)**
1. `render.ts:72` gains a heartbeat branch but no test asserts the rendered text for `source: "heartbeat"`. A one-line assertion in the CLI heartbeat test would satisfy the spirit of the event-schema rule.
2. `program.ts:375` and `:378` print `schedule: "heartbeat"` on failure. An ordinary entry with ID `heartbeat` produces an identical line. Adding `source` to that JSON would keep the stderr receipt as unambiguous as the event.
3. `agent-builder.ts:422` deletes a configured `shell` for checklist heartbeats. That is a silent behavior difference the contract does not name. If the intent is to avoid an `assertShellExists` failure, a comment would help; otherwise keep the shell.
4. `program.ts:382` reaches `heartbeatMaxTurns` through a cast. Declaring it on the options type would remove the cast and make the config-to-tick flow visible to the compiler.
5. `program.ts:353` passes a literal 5 in preview only to enable heartbeat detection. A named constant or comment would make clear the value is not used in preview.
6. Direct `runCommand` callers passing `heartbeat: "checklist"` get no 50-turn clamp; only the tick path validates. Runtime-only field, so low impact.
