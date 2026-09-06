# R6g — bounded catalogue and routing guidance

R6g follows R6c PR #151 and its green post-merge main `09157ae` CI 34022647578.
It is independent of R13d provenance transport: existing prompt sources and authority labels
are retained. This row changes discoverability guidance, not permission, budgets, default
generated discovery, evidence gates or emitter policy. No measured benefit is claimed.

## Manifest compatibility

Manual flat-v1 skills may include one optional string:

```markdown
---
name: release-review
description: Check a local release before publication
trigger: When reviewing a release or its verification results
---
Read the changes, run applicable tests and report remaining uncertainty.
```

The explicit generated-v1 metadata dialect additionally accepts optional
`agentrig-trigger: "When reviewing a release"` inside its two-space-indented `metadata`
map. All its existing required provenance fields remain required. Values remain strings;
unknown fields, duplicate keys, malformed YAML-subset input, collections and `allowed-tools`
fail closed. Simultaneous top-level `trigger` and `metadata.agentrig-trigger` refuses, even
when equal. Hintless legacy/plain/generated files retain their behavior. Older loaders reject
these new explicit fields; this is an additive compatibility extension, not arbitrary YAML.

Hints contain 1–1024 UTF-16 units before sanitization. Catalogue hints flatten control and
formatting characters and truncate to 160 Unicode code points. They are inert text, not regex,
actions, evidence, permission or executable matching rules. Text sanitization does not prove
semantic safety. Existing trust/discovery boundaries remain necessary.

R6b emits the same bytes as before. Adding a hint by hand counts as editing: regeneration
preserves the file rather than silently certifying new prose. Metadata labels never substitute
for fresh runtime evidence and effect review, and no new automatic activation is introduced.

## Catalogue and routing

The complete catalogue stays within 8 KiB UTF-8, including header, hint lines, omission note
and one worked `skill({"name":"actual-listed-name"})` call. Its input matches the tool schema.
The example names the first entry actually admitted under the cap, not a dropped input entry;
there is no example when no entry is listed. Catalogue construction emits no `skill.used`.

The default system prompt orders available-tool choices for the next action: relevant skill
preflight, existing background job management, purpose-built file/memory operation, substantial
independent delegated subtask, then remaining shell execution. First-match routing does not end
the whole task or omit required verification. Unavailable tools and unauthorized delegation are
not implied capabilities. Custom system prompts remain custom.

Effort numbers (one targeted fact lookup; 3–6 initial calls for bounded medium work) are advisory,
not new caps or quotas. Research, debugging and mandatory verification can require more within
configured limits. Approval and failure disclosure remain mandatory; reaching a limit requires
reporting incomplete work, not claiming success or increasing the limit.

## Validation

Network-free manual/parser, actual R6b emission/regeneration and real CLI-built request fixtures
cover hintless compatibility, safe hints, malformed/ambiguous input refusal, edited-file
preservation, default/custom prompt assembly, actual versus absent activation, multibyte total
caps and tool-schema-valid examples. Existing generated discovery and denial tests remain active.
Build, typecheck, full tests, detected/restored named mutations, one bounded independent review
and exact-head three-platform CI are required before root-controlled merge.
