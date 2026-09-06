# R9b independent review — original findings

One read-only Claude review of committed snapshot `1d7a538`, session
`7f1cee19-f134-4a87-a109-a26c20a67c2f`. Requested max 24 turns;
reported 22 turns, 238 seconds. The source stayed clean throughout.
Below is the final review text verbatim; see [R9b](R9b.md) for the author's response
and subsequent validation. The reviewer did not run build. Some line references
come from its concatenated file inspection; the finding is preserved as delivered.

**Verdict: REQUEST_CHANGES** on one narrow, rule-mandated gap. Everything else in R9b matches its contract and I would approve once that gap is closed.

**Material finding**

- **New event type lacks a render test.** `packages/core/src/events.ts:226` adds `eval.result`, and `packages/cli/src/render.ts:74` and `render.ts:199` add its cases, but no test anywhere calls `renderEvent` or `renderChatEvent` on an `eval.result` payload. `render.test.ts` has zero references to it, and the only tests touching the type are the forge test and result matching in `session-evaluation.test.ts`. CLAUDE.md requires "the zod variant, a `renderEvent` case, a test" for every new event. Control: add one `render.test.ts` case covering both render paths, including `advisoryPass: null` and a BLOCKED row.

**Independently verified, no defect found**

- Preview path constructs no provider, no Docker preflight, no output writes. Execution requires both caps and a fresh exclusive output directory (`session-evaluation.ts:78-87`).
- Baseline identity, task and pinned revision are bound before any provider call (`evaluation-fixtures.ts:53-55`, `session-evaluation.ts:59-61`).
- Main, supervisor, reviewer and grader all go through the same ledger wrapper. Retries, missing usage and stream errors mark a call incomplete and stop further scheduling, including advisory grading (`evaluation-budget.ts:341-386`, `evaluation-attempt.ts:273`).
- Advisory grading never writes a human verdict. Checker outcome must match its exit code and receipt identity or stays BLOCKED (`evaluation-attempt.ts:256-266`).
- Tool code cannot forge `eval.result`: it is absent from the tool-emittable allowlist enforced at `tool-execution.ts:158`.
- Original session logs are never opened for writing. The coordinator appends only to its own `evaluation.jsonl`.
- Owned cleanup: worker calls are tracked and joined after abort (`evaluation-attempt.ts:246`), preparation uses a real detached process group (`live-support.mjs:42-66`), and containers are removed by exact UUID name.

**Optional findings**

- ROADMAP row R9b at `docs/ROADMAP.md:644` carries no status annotation while STATUS calls the row implemented. Other rows annotate this.
- A-task dependency preparation has a fixed 120 second bound for `pnpm build` on two CPUs (`evaluation-preparation.ts:168`). A slow host BLOCKs before provider use, which is safe, but worth documenting.
- One stale container named `agentrig-e3-b73d6a4a-…` exists in Created state on this machine. It was created at 07:20Z with a different image and a `sleep 60` command, hours before my run, so it is not attributable to R9b. Worth removing manually.

**Independent commands and results**

```
pnpm typecheck                                  -> exit 0
AGENTRIG_EVAL_WORKER_IMAGE=sha256:f111ef59… \
AGENTRIG_EVAL_CHECKER_IMAGE=sha256:33443f68… \
pnpm exec vitest run --maxWorkers=4             -> 151 files passed, 2649 passed, 2 skipped, 40.67s, exit 0
git status --porcelain                          -> clean (snapshot unchanged)
```

**Limitations**

- I did not run `pnpm build`, since plan mode forbids writes and build emits `dist`. Typecheck covers the type surface.
- The default reporter does not list per-test names, so the Linux container pair's execution is inferred from the environment variables being set, the file passing, and the test count rising by exactly the new cleanup-order test.
- I could not write the requested plan file; only read-only tools were available this session.
