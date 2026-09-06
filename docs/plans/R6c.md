# R6c — opt-in generated-skill loading and usage labels

R6c follows delivered R6a/R6b/R5e and their runtime evidence/effect foundations. This row closes
the mechanical load/selection loop, independently of grant lifecycle or future R6g triggers.
It does not establish utility: generation and automatic generated-root discovery remain off
by default until a separately budgeted held-out comparison demonstrates benefit. No live
evaluation spending is part of this implementation.

## Explicit discovery

`--generated-skills` or trusted config `generatedSkills: true` appends generated directories
through the existing project-trust and safe-home boundaries. `--no-generated-skills` overrides
enabled config. The order is: explicit `--skills` directories, ordinary trusted-project skills,
ordinary safe-home skills, selected project-memory generated skills, safe-home generated skills.
Existing manual skills therefore keep precedence; an explicit directory can still override.
The bounded loader rejects malformed manifests and same-winning-precedence duplicates rather
than choosing filesystem enumeration order. Duplicate roots are deduplicated as before.

For the project root, an explicitly selected `--memory` / config `memory` directory uses the
same cwd-relative resolution as existing memory selection. With no explicit selection, it is
the trusted project root's `.agentrig`, including from nested working directories. Generated
files are under `<memory>/skills/generated`; safe-home files are under `~/.agentrig/skills/generated`.
An untrusted checkout contributes neither ordinary nor generated project roots. The home roots
are omitted when the checkout contains home, so repository-controlled user-state paths never
become implicitly trusted. Existing loader link/file/scan protections are unchanged.

`--no-skill-discovery` disables all automatic roots, including generated ones; explicit `--skills`
directories survive. An explicit/config `skills: []` still clears inherited explicit roots but
does not disable automatic discovery. There is no `--no-skills` flag. Custom SDK builders receive
the final `skills` root list; `loadRunConfig` resolves automatic roots for run, TUI and resume.

```sh
# R6b has already emitted reviewed files into .agentrig/skills/generated.
agentrig run "review this release" --generated-skills --allow skill
# Or use a non-default emitted memory directory:
agentrig run "review this release" --memory ./project-memory --generated-skills --allow skill
# Existing explicit-root selection remains available without automatic discovery:
agentrig run "review this release" --skills ./project-memory/skills/generated --no-skill-discovery --allow skill
```

Discovery is not permission. The examples explicitly allow the read-only `skill` tool;
default headless policy may otherwise ask/deny it because it declares no filesystem paths.
Explicit denial still wins, and interactive approval remains a separate existing mechanism.

## Metadata and events

`parseSkill` retains `generated?: true` only from R6b's validated versioned string-map metadata.
Names, directory substrings, body prose and model tool-input fields cannot set this marker.
The label says what the manifest declares, not that its author is authentic, its evidence is
fresh, its content was approved, or it improves outcomes. A manually configured directory is
explicit content selection, never an emission/effect receipt. Trusted SDK callers constructing
Skill objects remain responsible for their source; metadata never changes permissions.

Only successful actual model `skill` loads emit `skill.used` with optional literal
`generated: true`. Ordinary skills keep their exact legacy event shape. Missing/denied loads
and forged events from other registered tools do not count. JSONL persistence, parsing/replay
and verbose rendering preserve the added field; the existing core append/source authority is
unchanged. R9 can later measure these selection events, not infer success from their presence.

TUI `/skill-name` invocation still puts a delimited skill body in a user turn without emitting
`skill.used`; no new CLI session-log writer or user-selection telemetry is added. Child agents
receive the same discovered typed catalogue through their existing skills seam. There are no
R6g trigger hints, routing ladders, prompt examples, default generation or new permission grants.

## Delivery checks

Network-free actual R6b emission → CLI configuration → real buildAgent/model skill selection →
stored event roundtrip. Controls cover default-off/explicit/negative overrides, selected memory,
nested trusted root, unsafe home, untrusted project config, empty arrays, duplicate precedence,
ordinary/generated metadata, malformed version, forged model fields/events, missing and denied
loads, unchanged legacy records and strict optional event typing. Build/typecheck/full tests,
named detected/restored mutants, one bounded independent Claude review and exact-head three-
platform CI precede root-controlled merge and the post-merge gate. Closing PR records receipts.

Integrated main `97e18bf`; build/typecheck and full suite pass (2,167 tests plus two skips,
111 files), including 15 focused cases. Mutating default-off into default-on adds generated
roots in the named config control; dropping the event marker fails the actual generated
selection assertion. Both are restored. Independent review and final CI remain pending.
