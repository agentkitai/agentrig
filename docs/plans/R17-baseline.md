# R17a baseline — before R17b defaults

Measured 2026-09-07 on Linux x86_64, Node v24.12.0, pnpm 11.25.0,
from `origin/main` `4a6b7218c0241e3f2948d3ec92267bf44c0a164f`.
Builder: **agentrig**, conductor **8fbde1a3**. One child, one isolated worktree;
no default changes precede this commit. Live-provider tokens are not measured by
these fake fixtures; builder/conductor token usage is not observable here.

## Terminal measurements

| Measurement | Milliseconds / count |
| --- | ---: |
| Cold process start → first visible TUI prompt | 403.700 |
| Submit → first rendered streamed fake-provider token | 59.722 |
| `agentrig --help` top-level options, including help | 2 |

One cold-process sample, not a percentile or filesystem-cache-cold benchmark.
The TUI is a real CLI subprocess in a PTY, with an empty temporary HOME and cwd,
using a local, credential-free fake OpenAI SSE endpoint. No live model request is
made. The first-token clock starts when a separately delivered Enter submits the
input; the fake response is `BASELINE_TOKEN`. The 150 ms delays separating mount,
text entry and Enter are not included in submit-to-token latency. Initial fixture
friction is recorded in [feel #232](https://github.com/agentkitai/agentrig/issues/232).

The top-level command already has only `--profile` and `--help`. TUI-only options
are hidden from this help surface on main; this count does **not** claim the
underlying option/config surface is already small. R17b must migrate the toggles,
not merely hide more help entries.

## E1 deterministic reference traces

| Task | Permission prompts | Turns to done | Automatic behavior / evaluator outcome |
| --- | ---: | ---: | --- |
| A1 | 2 | 4 | PASS / PASS |
| A2 | 2 | 4 | PASS / PASS |
| A3 | 3 | 5 | PASS / PASS |
| A4 | 2 | 5 | PASS / BLOCKED (human prose review required) |
| X1 | 2 | 4 | PASS / PASS |
| X2 | 2 | 4 | PASS / PASS |
| X3 | 2 | 4 | PASS / PASS |
| X4 | 2 | 4 | PASS / BLOCKED (human prose review required) |

All eight Agent sessions terminate with `session.end(reason=done)`. These are
**scripted reference solutions, not an autonomous model capability score**. Each
trace reads the relevant source, writes the reference changes/tests or answer
files, then ends. One tool call per provider turn makes permission and turn
accounting reproducible. Default `RulePolicy(defaultRules)` is unchanged: the
fixture counts `onAsk` and answers allow once, without granting wider authority.
The evaluator's manual checks remain pending; no human verdict is fabricated.

The A tasks use the existing E1 pinned AgentRig revision; X tasks use the existing
offline is-number Git bundle. Task dependencies are installed offline before
running. The historical regression checker and submitted tests pass for A1–A3
and X1–X3. Task-session ids and measured numbers are retained in
`.agentrig/r17/baseline.json`; the complete fixture scripts are in that directory.

Reproduce after `pnpm install && pnpm build`:

```sh
python3 .agentrig/r17/terminal-baseline.py
node .agentrig/r17/task-baseline.mjs
node packages/cli/dist/index.js --help
```

The terminal fixture prints its PTY output and measurements. The task fixture
prints structured evaluator results and the temporary artifact/session directory;
manual-only BLOCKED outcomes are preserved. Fake token usage is unknown (the
provider does not manufacture usage events), not reported as zero.

## R17a delivery gate

- `feel` label created/verified with
  `gh label create feel --description 'AgentRig dogfood friction, usability and halts' --color E4E669 --force`.
- Every R17 PR and STATUS record names builder **agentrig**, conductor **8fbde1a3**;
  a blocked build instead names its blocking `feel` issue.
- Each row records child count, observable tokens and halts. Friction is filed
  before another child starts. This row currently has one child, token usage
  unavailable, zero halts and feel #232.
- This is the first R17b commit, containing only baseline/gate artifacts. R17a
  has no separate PR. No nested builder and no merge were performed.
