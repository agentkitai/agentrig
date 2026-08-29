# AgentRig

An agentic coding harness — SDK core plus a thin CLI — with two things most harnesses don't have built in:

- a **supervisor loop** that watches the session out-of-band, catches stalls and unproductive cycles, and redirects (from NVIDIA's AVO paper, generalized from "objective score" to proxy signals + rubric grading);
- an **LLM Wiki memory** (Karpathy's pattern): sessions are immutable raw sources, the agent maintains an interlinked markdown wiki about the project, and a scheduled **dream** runs the wiki's lint pass — contradictions, stale claims, orphans, promotion to a global wiki — on a copy, with a reviewable report.

Provider-agnostic. TypeScript monorepo: `core`, `memory`, `supervisor`, `cli`.

Spec: [`docs/PLAN.md`](docs/PLAN.md). Progress: [`docs/STATUS.md`](docs/STATUS.md).

```
pnpm install && pnpm build && pnpm test && pnpm demo
```

Status: M0 (event spine + session store + replay). Not usable yet.
