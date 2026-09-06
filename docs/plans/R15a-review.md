# R15a independent review — original record

Frozen head `8bf26a51659defa5fe7afc563f847cd55df9a576`, base `eead687`.
Session `41746acb-2677-4a1f-bb89-72fa4faa0ed0`: 24 requested turns, 31 reported;
the requested cap was not enforced. One invocation, 280.977 seconds, no permission
denials or subagents. Reported USD 2.95769 is list-price accounting, not subscription
billing. Author build/typecheck/full Docker checks are separate from the reviewer.

## Original final response (verbatim)

Review complete. Here is the verdict.

## Verdict: APPROVE

I found no material correctness, security or lifecycle defect in the R15a diff at the frozen head. Each control named in the brief holds up on inspection and under the tests I ran.

**Provenance grants no fresh-user authority.** A human answer produces a tool_result with `user` trust (`packages/core/src/question-runtime.ts:46`), but the only thing that lifts the external-input restriction is `expansion.user()`, which is called solely for the task and user steering (`packages/core/src/agent.ts:287,616`). Tool results only flow through `expansion.input()`, which never sets `pendingUser`. Automated sources map to `external` trust, so they re-arm the restriction. The core test for human, file and automated-initial sequences confirms the exec effect stays denied.

**Required-answer failure stops queued effects.** `state.failed` is set on null, invalid, timed-out or thrown answers, and the agent loop breaks with a fatal error before the next model call (`packages/core/src/agent.ts:940-945`). Later calls are refused twice: at the top of `executeToolInner` (`packages/core/src/tool-execution.ts:206`) and again inside `command()` after parallel admission (`tool-execution.ts:423`). The empty `paths` set makes `ask_user` schedule exclusively in the parallel runtime (`packages/core/src/parallel-runtime.ts:36,65`), so a sibling cannot start before the question settles. Abort remains abort: the TUI settles questions and calls `session.control.abort()` synchronously in the same tick (`packages/cli/src/tui/controller.ts:620,635`), so the runtime observes the aborted signal and does not set `failed`.

**Event and factory boundaries.** `question.asked` and `question.answered` are absent from `TOOL_EMITTABLE_EVENTS` (`packages/core/src/events.ts:159-165`), so tool emitters drop them. The binding seam is keyed on the original object plus its original `execute` in WeakMaps, so a spread copy or a renamed tool gets no handler. The forge test confirms both.

**TUI once-only settlement.** Each entry settles exactly once via the `settled` flag, clears its timer and abort listener, and removes only itself from the FIFO. Late answers are rejected by exact-entry comparison. Permission input wins because the permission branch returns before the question branch in the input handler.

**ACP local cancellation and reservations.** Local settlement aborts the runtime controller, which rejects `untilAbort` while the SDK request keeps its byte reservation until reply or close (`packages/cli/src/acp-server.ts:136-138`). Questions ride the existing outbound cap of eight in the transport. Unnegotiated clients settle null without an RPC.

## Optional polish, not blocking

- Slash commands typed while a question is pending become the answer text (`packages/cli/src/tui/app.tsx:145,188`). Escalation behaves the same way and Ctrl-C still aborts.
- No test asserts `ask_user` is absent in the `checklist` heartbeat. The suppression exists at `packages/cli/src/agent-builder.ts:604`, but `heartbeat.test.ts:143` only checks that bash is present.
- Interactive non-headless `run` answers permissions on the terminal but still fails questions by default (`packages/cli/src/run.ts:407-416`). This matches the documented headless contract.
- Free text of exactly "1" to "4" always maps to an option index (`controller.ts:585`).
- The controller's own 120-second timer can beat the runtime's, so the recorded outcome may read `unavailable` rather than `timeout`.

## Commands executed

```
git diff --stat eead687 8bf26a5
git diff eead687 8bf26a5 -- docs/ packages/core/ packages/cli/src/ packages/cli/test/
pnpm exec vitest run packages/core/test/questions.test.ts packages/cli/test/questions.test.ts packages/cli/test/question-acp.test.ts
pnpm exec vitest run packages/cli/test/heartbeat.test.ts packages/cli/test/acp-server.test.ts packages/cli/test/acp-transport.test.ts packages/core/test/tools.test.ts packages/core/test/parallel-strategy.test.ts packages/core/test/events.test.ts
```

| Run | Files | Tests | Result |
|---|---|---|---|
| New question suites | 3 | 28 | all passed |
| Adjacent regression suites | 6 | 123 | all passed |

## Limitations

- I did not run build, typecheck or the full suite. The subprocess tests used `packages/cli/dist`, which was built by the author seconds after the HEAD commit, not by me.
- I did not run the named mutation checks, since this review was read-only. The claims are consistent with the code paths I traced.
- Docker sandbox enforcement was not exercised in my runs.
- I did not inspect the R15e merge conflict resolution beyond the abort path in the controller.

