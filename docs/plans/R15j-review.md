# R15j independent review receipt

One frozen review of e5890c0 against 9aca391. Session 1fad74e1-9dd1-4d2c-8b2c-4d240f831b6e.
Requested max 24 turns; actual **30 turns**, 234.216 seconds, exit 0.
Outer timeout 600 seconds; no denied commands. Requested turn cap was not an
enforced actual-turn ceiling. No second broad review.

## Original result (verbatim)

Review complete. Verdict below.

**Verdict: APPROVE** for R15j commit e5890c0 against base 9aca391. Both focused test files pass (12 of 12, maxWorkers=2). I found no material correctness or security regression in provider selection, lifecycle, authority, caps, opaque reasoning, native output or replay. One concrete but low-impact regression is noted for follow-up.

**What I verified in the diff and surrounding source**

- **Selection is sampled once per run and stays concrete.** `createAgent.run` resolves the trusted resolver before `runSession`, strips the resolver from the per-run config, and replaces only `provider` (packages/core/src/provider-selection-runtime.ts:680-690). Tools, hooks, permissions, toolAllowlist, extensions and spend are the original objects. The CLI control selects only from the resolved R3.5 table, refuses ambiguous role/entry names, and unknown entries (packages/cli/src/provider-selection.ts:176-179).
- **Lifecycle.** The controller checks closing/session/running/undo/dream/review/selecting/pending/question/escalation before reserving, rechecks agent identity, session id and closing after synchronous prepare, and clears `selecting` in `finally` (controller.ts:354-368). Quit during selection joins the shutdown path; the ACP `prompt()` transport is blocked while selecting. Since prepare and commit are synchronous, reentrancy is only via callbacks, and the reentrant-close test covers that.
- **Authority.** No permission, sandbox or tool authority is derived from the selection. The event variant is a strict schema; a forged `provider.switched` via `control.record` is rejected (core test). The `it.each` external/role/deny controls show no widening after a switch.
- **Caps and metering.** Every variant is built through the same `buildEntry` path, prepare then meter (packages/cli/src/provider.ts:163-164), so lazy effort variants are metered with the same ledger. `resolveAgentProvider` asserts the chosen provider carries the same-ledger meter whenever a cap is configured, matching the construction-time check in `createAgent`. The cache is keyed by entry plus effort and bounded at 128 without dropping the committed selection.
- **Opaque reasoning.** `validateHistory` runs before the switch event, manifest, and metered admission (agent.ts:812; spend-ledger.ts:803). All three adapters already validated thinking history inside `stream` (openai.ts:53, anthropic.ts:32, openai-chatgpt.ts:71/343), so this only moves refusal earlier. Raw history is not rewritten; the core test confirms the preserved block and zero fetch/admit.
- **Native output.** The prepare hook now flags every OpenAI-compatible instance, including lazy variants, before the metering wrapper, and still fails closed when the main entry is not OpenAI-compatible. Non-supporting entries are refused both in `prepare` and at run resolution.
- **Replay.** `providerSelection` on `context.manifest` and the snapshot are optional and additive. `materializeSnapshot` derives it from the last manifest, so fork/resume keep the mapping and a same-selection resume emits no spurious switch. Legacy traces lose nothing. `renderEvent` and `renderChatEvent` cases exist.

**Concrete finding (non-blocking, recommend fixing in this row or as polish)**

- **Unbounded configured names now fail at runtime.** `ProviderSelectionInfoSchema` caps `entry`, `provider` and `model` at 128 control-free characters (packages/core/src/provider-selection.ts:700-702), but config allows any non-empty model string and any regex-matching entry name with no length bound (packages/cli/src/config.ts:34, 55-64). Because `buildAgent` always wires the resolver, a previously valid config with a model name over 128 characters now throws a raw ZodError at TUI startup in `controller.setProviderSelection` (start.tsx:113, outside the surrounding try) and on every `agent.run` for the non-TUI path. Nothing in the R15j contract requires accepting such names, and they are uncommon, but the failure is uninformative and occurs without ever using `/model`. Suggested fix: bound `model` and entry names in the config schema so the refusal happens at config load with a clear message.

**Optional polish**

- No test exercises `renderEvent` or `renderChatEvent` for `provider.switched`; CLAUDE.md asks for a test per new event type. The zod variant is tested.
- `/effort <level>` equal to the entry's configured default builds a second, separately metered instance keyed `[entry, level]` alongside `[entry, null]`. Harmless, but it consumes a variant slot.
- History is validated three times per request (agent loop, meter wrapper, adapter stream). Redundant, not wrong.

**Limitations, as stated in the contract**

- Same-format cross-model replay compatibility and per-backend effort support are not verified locally; remote rejection is surfaced, not retried.
- `mcp-serve.ts:59` captures the live provider getter once at startup. That path has no selection control, so there is no drift today.
- The status/maintenance integration points (R16f/R16g) were not evaluated beyond confirming `state.selecting` and `resolveAgentProvider(config).config` exist as described.

## Author disposition

APPROVE retained. The concrete bounded-name startup issue is fixed: config rejects
oversized model/entry/role names; trusted flag tables and actual provider metadata
are checked with a fixed diagnostic inside the protected builder boundary, before
TUI attachment or a model call. The bounded-name regression failed before and passes
after. Canonical switch renderer controls now cover unknown/known prior selection.

Author-found selected→legacy→fork metadata gap reproduced: live snapshot correctly
cleared selection, but fork materialization retained an earlier label. Every manifest
now replaces the optional selection, including absence; the exact regression failed
before and passes after. This finding is not attributed to the reviewer. Dedicated
selection/config group: 65 passed. Redundant same-default variants/validation remain
optional polish; no second review.
