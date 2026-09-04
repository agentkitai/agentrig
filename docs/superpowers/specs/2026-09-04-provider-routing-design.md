# Provider routing: named provider entries, per-role selection, and an external review pair

Date: 2026-09-04. Status: design approved in conversation, pending implementation plan.
Authorization: this work is not a roadmap row. Amit authorized it on 2026-09-04 as an inserted band,
proposed name `R3.5` (following the `R1.5` precedent), to be recorded in `docs/ROADMAP.md` and
`docs/STATUS.md` by the first PR.

## 1. Goal

Run the coding work of a train on a local model while planning, judgment, and memory stay on
stronger cloud models, and have every PR reviewed by two external reviewers that share nothing
with the builder.

Concretely, on Amit's machine:

| Role | Entry | Model |
|---|---|---|
| Conductor / TUI main loop | `cloud` | `gpt-5.6-sol` via `openai-chatgpt`, reasoning effort `max` |
| Builder, fixer, lander children | `local` | `qwen3.8-27b` via llama.cpp at `http://127.0.0.1:8080/v1` |
| Arbiter child | `cloud` | named explicitly at spawn |
| Independent PR review | external CLIs | Claude Code (`claude -p`, pinned `claude-opus-5`) and Codex (`codex review`), in parallel |
| Supervisor reviewer and grader | `cloud` | `gpt-5.6-sol` |
| Memory ingest and dream | `cloud` | `gpt-5.6-sol` |
| Compaction | not a role | follows whichever loop it runs in |

## 2. Context (verified 2026-09-04)

- AgentRig constructs exactly one `ModelProvider` per process (`packages/cli/src/provider.ts:34`,
  called from `packages/cli/src/agent-builder.ts:374`) and hands that instance to the main loop,
  every child (`agent-builder.ts:337`), the supervisor reviewer and grader (`packages/cli/src/run.ts:264-265`),
  ingest and dream hooks (`agent-builder.ts:436,447`), and compaction. No per-role selection exists.
- The spawn tool lives in core (`packages/core/src/tools/subagent.ts:26-33`); its input is `task`
  and `label` only. The child's provider arrives through the injected `childConfig()` closure.
- `ConfigValuesSchema` (`packages/cli/src/config.ts`) is `.strict()`; precedence is
  `defaults < user < user profile < project < project profile < env < explicit CLI`, objects
  replaced never merged. A guard rejects any key that looks like a credential anywhere in the file.
- `contextWindow` is a constructor option on all three adapters but is not configurable; a local
  model is assumed to have 128K and compaction fires at 70% of that.
- No adapter sends a reasoning effort. Codex on this machine runs `gpt-5.6-sol` at `max`.
- `session.start` already records `provider` and `model` (`packages/core/src/events.ts:154-158`),
  so a child's model is already in its own log. No event schema change is needed.
- Amit has no Anthropic API key. Anthropic prohibits subscription use outside its own products, so
  Claude participates only through the `claude` CLI. An OpenAI API key and a Codex subscription
  credential are both present; the existing `personal` profile runs `openai-chatgpt` / `gpt-5.6-sol`.
- Both external CLIs run headless from inside an agent session. `codex exec` worked directly.
  `claude -p` reported "not logged in" until the `CLAUDE*` nesting variables were unset and stdin
  was closed; with `--model claude-opus-5 --output-format json` the result's `modelUsage` keys
  were exactly `["claude-opus-5"]`.
- The `dogfood` skill already runs this exact external pair (§8) for standalone runs; `ship` and
  `topic` skip it in the child and spawn a reviewer subagent instead, which would inherit the
  builder's local model.

## 3. Config schema

Two new keys in `ConfigValuesSchema`, valid at top level and inside a profile.

```jsonc
{
  "providers": {
    "cloud": { "provider": "openai-chatgpt", "model": "gpt-5.6-sol", "reasoningEffort": "max" },
    "local": { "provider": "openai", "baseUrl": "http://127.0.0.1:8080/v1",
               "model": "qwen3.8-27b", "contextWindow": 98304 }
  },
  "roles": { "main": "cloud", "supervisor": "cloud", "memory": "cloud", "subagents": "local" }
}
```

**Entry.** `provider` is the existing enum (`anthropic | openai | openai-chatgpt`). `model` is
required. `baseUrl` (URL), `contextWindow` (positive integer), and `reasoningEffort`
(`minimal | low | medium | high | xhigh | max`) are optional. Entry names match
`^[a-z][a-z0-9-]*$`; `default` is reserved. Entries never carry credentials; the existing guard
already rejects credential-shaped keys at any depth, and keys keep coming from the environment per
provider kind exactly as today.

**Roles.** `main`, `supervisor` (trajectory reviewer and rubric grader), `memory` (ingest and
dream), `subagents` (the default entry for children). Each names an entry. Resolution:
`roles[role] ?? roles.main ?? "default"`.

**The implicit `default` entry.** The flat keys `provider`, `model`, `baseUrl` continue to work
and define `default`. Two new flat keys, `contextWindow` and `reasoningEffort`, complete it. A
config with no `providers` block behaves exactly as today.

**CLI flags.** No new flags. If any of `--provider`, `--model`, `--base-url` is explicit, or
`AGENTRIG_MODEL` is set, the `main` role becomes the `default` entry built from those values,
exactly today's behaviour. Other roles still resolve through `roles`.

**Precedence.** Both keys follow the existing contract: a `providers` or `roles` object at a
higher-precedence layer replaces the lower one wholesale.

**Validation at load.** Every role must name an existing entry; the error names the role and the
missing entry. Every entry a role references is constructed eagerly at startup, so a missing credential
fails immediately rather than at the first supervisor escalation. An entry no role references is
schema-validated but not constructed.

## 4. Reasoning effort

`reasoningEffort` is an adapter constructor option applied to every request from that entry. It
does not enter `ModelRequest`. Sent only when set:

| Adapter | Wire field |
|---|---|
| `openai-chatgpt` (Responses API) | `reasoning: { effort }` |
| `openai` (Chat Completions) | `reasoning_effort` |
| `anthropic` | `output_config: { effort }`, `minimal` mapped to `low` |

Values pass through unmodified. A backend that rejects a level for a model returns its 400 at the
first request through the existing error path, with the entry name attached. The `local` entry
omits it; llama.cpp controls thinking through the chat template.

## 5. Runtime wiring

- **`buildProviders(config): ProviderSet`** replaces `buildProvider(opts)` on every production
  path. `ProviderSet` exposes `main`, `supervisor`, `memory`, `subagents`, `get(name)`, and
  `names`. The same entry name yields the same instance. All referenced entries are constructed
  eagerly.
- **Agent builder.** `createAgent` receives `main`; ingest and dream hooks receive `memory`.
  `BuiltAgent` gains `providers: ProviderSet` and keeps `provider` as an alias of `main`.
- **Supervisor split.** `SupervisorWiring` gains `reviewProvider`. USD accounting
  (`run.ts:255-260`) keeps reading rates from `main`, because the usage it meters comes from the
  main loop. `TrajectoryReviewer` and `RubricGrader` are constructed with `reviewProvider`, which
  the CLI sets to `supervisor`. The TUI path (`packages/cli/src/tui/start.tsx:71`) does the same.
- **Spawn tool (the one core change).** `SubagentOptions` gains optional `providerNames: string[]`
  and a description of which name is the default and which is the main session's. When names are
  supplied, the input schema gains `provider: z.enum(names).optional()` with that description;
  when absent, the schema is byte-identical to today. `childConfig` takes the chosen name (or
  `undefined`). Default is always the `subagents` role, including for grandchildren; a child's own
  entry is never inherited implicitly. The depth+1 re-wrap in `subagent.ts:185-195` passes the
  names through unchanged.
- **Standalone `memory ingest` and `dream`.** Resolve through the same set, defaulting to the
  `memory` role; explicit `--provider` / `--model` on those commands wins by the same rule as `main`.
- **Doctor.** Iterates every entry: credential present for its kind, model set, base URL well
  formed; prints a role-to-entry table; reports a role naming a missing entry as a failure.
- **Failure policy.** An unreachable or failing entry fails the role that hit it, with the entry
  name in the error. There is no fallback to another entry.

## 6. Train review via the external pair

Touches `.agentrig/skills/topic/SKILL.md`, `.agentrig/skills/ship/SKILL.md`, one paragraph of
`.agentrig/skills/dogfood/SKILL.md`, and a one-line note in `.agentrig/skills/review/SKILL.md`.
The review skill's substance is unchanged; it becomes the brief handed to Claude.

- **One worktree, two reviewers, in parallel.** Where topic step 4 and ship step 2 say "spawn a
  reviewer subagent", the conductor instead resolves the PR's current head SHA, creates an
  isolated worktree at that commit with `origin/main` merged in, runs `pnpm install` there once,
  and launches two background jobs with that worktree as the working directory, polling with
  `bash_job` as dogfood §8 prescribes.
- **Claude job.** Dogfood's command line, verbatim in substance: `--model claude-opus-5`,
  `--permission-mode plan`, `--allowedTools 'Read,Grep,Glob,Bash'`, plus `--output-format json`
  and `--no-session-persistence`, run with the `CLAUDE*` nesting variables unset and stdin from
  `/dev/null`. Brief: "Review PR #NN at head SHA X. Read `.agentrig/skills/review/SKILL.md` and
  follow it. You are already in an isolated worktree; skip its worktree step. Report the SHA you
  reviewed." The conductor reads `result` as the review and asserts that `modelUsage` contains
  exactly the key `claude-opus-5`; any other key is a failed review, never a substitute.
- **Codex job.** `codex review --base origin/main` in the same worktree, with a prompt carrying the
  same adversarial standard: assume the author is wrong, verify before reporting, report file:line,
  severity, a concrete failure scenario, and a fix.
- **Merge.** The conductor takes the union, tags each finding with its reviewer, collapses
  duplicates, and feeds the result into the existing repair loop unchanged.
- **Delta re-review.** Both reviewers again, in parallel, over old-to-new head SHAs in a refreshed
  worktree. Parallel jobs cost the wall-clock of the slower one, so two reviewers on the delta add
  eyes without adding rounds.
- **Failure.** A job that dies or times out is retried once on the same head. Both reviewers
  failing on the same head halts the train, the same rule as a child dying twice.
- **Provenance.** External reviews have no session id. The conductor posts each review verbatim as
  a PR comment headed by reviewer name and reviewed SHA, and its final report cites those. Raw
  outputs are also in the conductor's own log as tool results.
- **Arbiter.** A judgment role: topic spawns it with the main session's entry named explicitly,
  using the spawn field's description to find that name rather than hardcoding one.
- **Dogfood §8 paragraph.** The child still skips the section. The rationale changes: the conductor
  runs the pair because children may run on a local model and the review must not share the
  builder's model.

## 7. Testing

- `packages/cli/test/config.test.ts`: both keys parse; name regex; reserved `default`; a role naming
  a missing entry is rejected with role and entry named; the credential guard catches `apiKey`
  inside an entry; a profile may carry both keys; a project block replaces a user block; flat
  `contextWindow` and `reasoningEffort` parse.
- New `packages/cli/test/providers.test.ts` (or extend `provider-flags.test.ts`): role fallback
  chain; same entry, same instance; eager construction failure names role and entry; explicit CLI
  flags move only `main`; `contextWindow` and `reasoningEffort` reach the adapter constructor.
- `packages/cli/test/subagent-wiring.test.ts`: default child entry is `subagents`; an explicit
  name resolves; grandchild default rule; names passed through the depth re-wrap.
- `packages/core/test/subagent.test.ts`: enum field present only when names are supplied; an
  unknown name is a validation error, not a crash.
- Adapters (`openai.test.ts`, `anthropic.test.ts`, `openai-chatgpt.test.ts`): the effort field
  appears only when configured; Anthropic maps `minimal` to `low`.
- Run wiring: reviewer and grader receive the supervisor provider; accounting reads `main`.
- `packages/cli/test/doctor.test.ts`: entry table; per-entry credential checks; missing-entry role
  reported.
- Memory and dream command tests: default to the `memory` role.

Every test uses the existing inline fake `ModelProvider`; nothing touches the network.

## 8. Docs and roadmap

- `docs/PLAN.md`: §5 config line gains `providers` and `roles`; §2.2 gets a note on named entries.
- `README`: config example with both keys.
- `docs/ROADMAP.md` and `docs/STATUS.md`: inserted band `R3.5`, two rows.
- Skill files per §6.

## 9. Delivery

Two PRs, sequential.

1. **R3.5a, code.** Config, `ProviderSet`, wiring, spawn field, reasoning effort, doctor, tests,
   PLAN and README notes, STATUS row.
2. **R3.5b, skills.** Topic, ship, dogfood, review text per §6. Depends on the spawn field for the
   arbiter. This PR is the first real dogfood of the first.

Rollout on Amit's machine after R3.5a: add `providers` and `roles` to the `personal` profile with
`cloud` at `reasoningEffort: max` and `local` at `contextWindow: 98304`; run `agentrig doctor`;
run a short supervised toy task and confirm all four roles resolve in the log; then run the next
roadmap row as a topic train on the new setup.

## 10. Out of scope

- A `command` provider kind wrapping an external CLI as an in-process provider. The external pair
  is a skill-level step; if the supervisor's judges ever need to be Claude, this is the follow-up.
- Per-entry `apiKeyEnv` for a second keyed OpenAI-compatible service. Not needed today.
- Automatic fallback between entries. Rejected: it hides quality drift and cost changes.
- Reading `contextWindow` from the llama.cpp `/props` endpoint. A config value is explicit and
  works for every server.

## 11. Decisions made in the design conversation

- Driving mode is mostly trains, so `main` defaults to cloud and children default to local.
- Cloud is the OpenAI subscription for every in-process cloud role; no Anthropic API access exists.
- Claude participates only via `claude -p`, pinned to `claude-opus-5` and asserted per run.
- Two external reviewers, always both, always in parallel, including delta re-reviews.
- Named provider list with role references, over flat per-role keys or profile reuse.
- Grandchildren default to the `subagents` role rather than inheriting the parent child's entry.
- `reasoningEffort` is in scope now rather than deferred.
- PR comments carry review provenance since external reviews have no session id.
