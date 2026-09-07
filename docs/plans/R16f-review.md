# R16f independent review

Frozen commit: `4fe3284`, base `9aca391`. One read-only Claude process; session
`1b00d928-baf4-44ee-9b50-d5d857263e74`. Requested `--max-turns 24`; the CLI
reported **38 turns**, exceeding that requested cap, and 345.038 seconds. No
restart or final-summary continuation. No material findings. Author build and real
Chromium checks are separate from the independent checks below.

## Original reviewer response (verbatim)

**Verdict: APPROVE.** No material findings against the R16f contract at 4fe3284 (base 9aca391).

**What I verified by reading code**

- **Run identity** comes only from the runtime binding. `bindSessionSpend` at `packages/core/src/agent.ts:285` runs inside `withSpendRun`, so each Session object gets its own fresh segment. `sessionSpendSource` at `packages/core/src/spend-runtime.ts:17` is keyed on the object via a WeakMap, so a plain id or the builder's construction segment cannot select it. Same-id resume produces a new object and thus a new generation in `observeStatus`.
- **Maintenance child vs selected parent.** The controller's `set()` guard at `packages/cli/src/tui/controller.ts:370` only clears the observed session when the selected id changes to something other than the observed run's id. The run path observes before it publishes the id, so ordering is correct. Nothing in production yet calls `observeStatusSession` for a child, which matches the contract leaving that to R16g.
- **No mutation from rendering.** The footer path only calls `SpendLedger.report` (pure fold over records, `spend-ledger.ts:166`), `PermissionGrantRegistry.inspect` (pure), and `LadderPolicy.snapshot` (returns a fresh object). No events, logs, providers, or permission code changed in the diff.
- **Ladder snapshot** mirrors the exact rung selection used by `decide` at `policy.ts:128`, on the capability-filtered `rungs` array, before confidence, cooldown, progress and signature checks. Custom policies yield null via `attach`, which the controller labels unknown.
- **Posture and sandbox** are read live from the merged trusted config. The TUI command resolves options through `loadRunConfig` (`program.ts:524`) before `startTui`, so a project config `sandbox` or `yolo` is reflected. The `ask` label means fallback policy, as documented.
- **Mount-only reads, shutdown and remount.** Polling starts only from `mountStatus`, which requires `configureStatus`, called only in `start.tsx`. Headless ACP/MCP controllers never configure it. Unmount awaits the in-flight read, and remount waits on that close before restarting.

**Independent checks I ran**

| Check | Result |
|---|---|
| `pnpm typecheck` (4 packages) | pass |
| Focused: status-snapshot, status-startup, tui-status, spend-ledger, all supervisor tests | 16 files, 318 passed |
| Full `pnpm test` | 190 files, 3037 passed, 2 skipped |
| Docker-required `session-evaluation` + `nightly-structure` with `AGENTRIG_EVAL_REQUIRE_DOCKER=1` and the local r9b image IDs | 2 files, 33 passed |
| Ad-hoc render probe of `statusLine` via Node type stripping (mixed complete/unknown run, in-flight reservation, exhausted ladder, 500-char model with ESC sequence) | Output matched the documented labels; ESC replaced, length bounded to 214 chars |

**Not independently verified**: `pnpm build` (I ran typecheck only, no emit), whether the web test launched real Chromium versus skipping inside the full run, and exact-head CI. No live model or provider requests were made.

**Optional polish, none blocking**

- `controller.ts:283`: a null snapshot from a detached observer maps to "unknown", while the contract says detached is "unavailable". Unreachable in practice because the observer is cleared before the session ends.
- `status.ts:11`: a priced run whose only call is still in flight renders `run tokens:0/0/0/0 cost:?`. The zeros are the absence of a usage snapshot, not reported tokens. Reproduced with the probe above using `calls:1, completeCalls:0, reportedUsage all zero`.
- `controller.ts:286`: a second concurrent `mountStatus` returns a no-op cleanup, so the first mounter's unmount stops observation for both. Ink has one App, so this is theoretical.
