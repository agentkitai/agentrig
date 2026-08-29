# AgentRig — agentic harness with a built-in supervisor loop and LLM Wiki memory

Read `docs/PLAN.md` before doing anything. It is the spec: package interfaces, the event schema,
the memory design, the supervisor design, and the milestone order. `docs/STATUS.md` says which
milestone is current. Work on the current milestone only; do not pull later milestones forward.

## Commands

```
pnpm install          # pnpm 11; build scripts are allowlisted in pnpm-workspace.yaml
pnpm build            # tsc per package, topological order
pnpm test             # vitest; tests import workspace packages by name, resolved to src (no build needed)
pnpm typecheck
pnpm demo             # writes a synthetic session under packages/cli/.agentrig/sessions and replays it
node packages/cli/dist/index.js sessions ls|show <id>
```

## Layout

```
packages/core        agent loop, tools, permissions, sessions, providers — the event-sourced spine
packages/memory      LLM Wiki memory (raw → wiki → schema; ingest / query / lint=dream)
packages/supervisor  detectors, policy ladder, interventions, reviewer, grader
packages/cli         thin CLI over the SDK
docs/PLAN.md         the spec
docs/STATUS.md       milestone tracker — update it when you finish or change scope
```

## Rules

- The event schema in `packages/core/src/events.ts` is the contract between packages. Add fields; never
  repurpose or remove them. Every new event type needs: the zod variant, a `renderEvent` case, a test.
- `memory` and `supervisor` depend on `core` for types only. Never import core internals into them.
- `raw/` is immutable. Only `SessionStore.append` writes session logs. Nothing rewrites a JSONL file.
- Providers map to/from the unified `Message`/`ContentBlock` schema. Core never sees a vendor payload.
- Strict TypeScript, ESM, `verbatimModuleSyntax`. zod for anything that crosses a process or file boundary.
- Tests live in `packages/<pkg>/test/*.test.ts` and import from `@harness/<pkg>`.
- Packages publish under the `@agentkitai` scope as `agentrig-<pkg>`; they stay `private` until M1 is usable.
- Keep the CLI thin. If a command needs logic, that logic belongs in a package.
- Prefer small PRs that complete one row of the milestone table over sweeping changes.

## Definition of done for a milestone

`pnpm build && pnpm test` green, `docs/STATUS.md` updated, and the harness was used (or is now
usable) to work on the next milestone.
