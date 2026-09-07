# R17b — DEVIATION REQUESTED (not approved)

Builder **agentrig**, conductor **8fbde1a3**. One child, one isolated worktree,
zero nested builders; observable token usage unavailable; one halt. Blocking feel
issue: [#233](https://github.com/agentkitai/agentrig/issues/233). No defaults have
changed. The first commit already contains R17a baseline/gate artifacts.

## Contract, verbatim

| R17b | **Defaults pass** (the first PR of the band; its first commit carries R17a's artifacts): one recommended profile becomes the zero-config default: Markdown rendering, post-edit diagnostics, prompt history, notifications, Git checkpoints when the workspace is a repository, session-end memory ingest, supervisor heuristics, tool summaries, thinking preserved. Every flag that only toggles one of these becomes a config key with the default on; the CLI keeps `--profile` and a small explicit set. Security defaults (`ask`, sandbox, grants, fail-closed manifests) do not move. A migration note lists each flag that changed meaning | cli + core |

R17b — a fresh clone with no config runs a task and the transcript shows
rendered Markdown, a diagnostics line after an edit, a checkpoint event, and an ingest at session
end; `agentrig --help` lists fewer than 40 top-level options.

Renunciation: no new capability in this band. Every row makes something that exists default,
measured, visible or cheaper. Security defaults move only toward less prompting for
already-authorised operations, never toward wider authority.

## Facts and reproduced behavior

- `packages/core/src/agent.ts:287-288` rejects any host-process hook under an
  enforcing sandbox before creating a session. This is an intentional security
  boundary, not a default that R17b can silently relax.
- `packages/cli/src/agent-builder.ts:636` installs checkpoints as a host hook;
  lines 640–651 install session-end ingest as another host hook.
- `docs/plans/R4a.md:12-13` explicitly says the H1 hook/sandbox restriction stays
  and native Git is not made part of an OS sandbox.
- The exact executable reproducer is retained in feel #233. Assertions prove
  `createAgent` with `workspace-write` and no hooks constructs; adding either a
  Checkpointer or a session-end ingest-shaped hook throws the existing message:
  `sandbox modes cannot contain host-process hooks; remove hooks (including ingest/dream-on-end) or explicitly select sandbox none`.
- Therefore unconditional default hook installation turns an existing explicit
  enforcing-sandbox launch into a pre-task failure, even if the user did not opt
  into either hook. Automatically selecting sandbox none would widen authority.

## Proposed narrow exception

Recommended-profile **implicit** checkpoint and session-end ingest defaults apply
only with sandbox absent/none (and checkpoint creation still requires a Git
repository). With an enforcing sandbox, omit those two implicit hooks and emit a
visible reason. An explicit opt-in to either hook retains the existing fail-closed
startup error. Do not change ask, sandbox mode/network, grants, manifests, or the
core host-hook guard. Do not add sandbox-safe hook execution in this band.

The zero-config acceptance remains unchanged because the existing zero-config
sandbox is none. All other recommended defaults remain in scope.

## What is lost

The literal all-context interpretation of checkpoint/ingest defaults: an explicit
enforcing-sandbox session will not automatically checkpoint or ingest. There must
be a visible explanation and regression coverage, not a silent omission.

## Alternatives

1. Keep unconditional defaults and preserve the guard. This is secure but makes
   previously valid sandbox-only launches fail until the user supplies two new
   config opt-outs. This is buildable but measurably worse startup behavior.
2. Introduce sandbox-safe Git and ingest hooks. This is new capability, outside
   R17's renunciation, and requires a separate security design.
3. Switch sandbox to none or exempt these hooks from the guard. Rejected by the
   builder as an authority widening; no such implementation was attempted.

## Exact proposed roadmap edit (conductor/arbiter only)

Replace:

> Git checkpoints when the workspace is a repository, session-end memory ingest,

with:

> Git checkpoints when the workspace is a repository, session-end memory ingest (these two implicit defaults apply only with sandbox absent/none; enforcing sandboxes visibly omit them, while explicit hook opt-ins retain the existing fail-closed error),

No acceptance or renunciation text changes. No roadmap edit has been made, and
this proposal is not an approval record. Resume implementation only after the
conductor's arbiter verdict (or implement unconditional defaults if rejected).
