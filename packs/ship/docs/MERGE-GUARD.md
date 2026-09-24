# Minimal ship merge guard (R19f slice 2)

The ship dispatch extension composes its existing ledger-integrity handler with a
`pre_tool` merge guard. This is not a replacement for the land skill. Review
resolution, review evidence, mergeability, row completion and post-merge CI remain
with that skill, unchanged. The guard does not read or invent review evidence.

The initial host prompt's adjacent `Row: <JSON>` and host-generated row-binding
line provide the only authorization source. Later prompts cannot replace it.
The PR body must contain that exact authorization string and the own-line row
binding. A successful `pre_spawn` dispatch posts and reads back the existing
GitHub dispatch record. `post_spawn` supplies the child ID after core emits the
spawn event; only an exact matching parent/task/role/provider/tools envelope can
bind that child to the dispatched PR. Only the named `lander` role is eligible.
A merge re-fetches the dispatch comment and refuses an edited/missing record.
Authority is intentionally live-process state: after a host restart, redispatch
rather than reconstructing grants from child text or GitHub prose.

CLI children share activated extension **pre_tool** hooks, retaining their closure
state; they do not inherit extension tools, pre-model hints, session-end hooks or
parent checkpoint hooks. Direct SDK hosts must explicitly supply the same
pre-tool hooks to their child configuration. Merely importing this extension in a
separate child process cannot establish a grant.

## Bounded merge commands

Use one literal foreground command, with explicit PR identity and a current-head
compare-and-swap argument:

```
gh pr merge NUMBER --squash --match-head-commit FULL_HEAD
# or
gh api repos/OWNER/REPO/pulls/NUMBER/merge -X PUT -f sha=FULL_HEAD -f merge_method=squash
```

The guard obtains required checks through `gh pr checks --required`, verifies each
against check runs or statuses fetched from the exact commit, then re-fetches the
PR head/body before allowing execution. Missing requirements, truncation,
ambiguous names, skipped/red/pending checks, malformed responses and fetch errors
refuse with a reason. The pinned merge SHA closes the head-change race after the
last read. No deferred `--auto` merge is authorized by a transient green result.
GraphQL merge mutations, curl merge calls, input-file API merges and shell
wrappers/operators are refused; use the literal REST or PR form above.

Like ledger integrity this is a bounded command gate, not a shell sandbox or a
GitHub transaction. Indirect scripts or dynamically constructed commands are not
interpreted, and GitHub branch protection must remain enabled. Branch protection
is also the backstop against check results changing after the final read. Ordinary
reads and unrelated tools remain unchanged. The API/CLI fetch budget is 25s,
below the registered 30s hook deadline.

## Activate this PR's guard for its own landing

An already-running conductor uses the code it loaded at startup. Checking out the
new files does not hot-reload its hooks or child wiring. After independent review
and exact-head CI, the conductor should use an **owned landing checkout of the
reviewed head** (never switch or edit the author's checkout), build it, and launch
a fresh coordinator with that checkout's CLI and explicit dispatch extension.
Keep the land skill, reviewer schema/helpers and evidence base-pinned as usual;
loading this reviewed guard does not replace those policy inputs.

1. In that owned checkout, create a temporary trusted role file
   `.agentrig/agents/lander.md` (do not commit it):

   ```markdown
   ---
   schema: 1
   tools: ["bash", "bash_job", "read_file", "glob", "grep", "skill", "read_output"]
   model-role: subagents
   delegable: false
   ---
   Follow the base-pinned land skill for the single assigned PR. Do not spawn.
   ```

   Use the existing configured subagent provider, or an explicitly selected
   provider entry in the role; no provider identity is inferred from task prose.
2. Launch that checkout's `node packages/cli/dist/index.js run` with `--trust`,
   `--sandbox none`, `--subagents`, `--extension` pointing to its
   `packs/ship/extensions/dispatch-record.mjs`, `--no-extension-discovery`, and
   explicit external `--root`/`--memory` paths. Preserve the required environment
   and the conductor's profile. Pass base-pinned skills with the existing skills
   configuration. Use sufficient child turn/budget limits for the land skill.
3. The fresh coordinator's **initial** prompt must contain adjacent lines:

   ```text
   Row: {"task":"R19f slice 2: minimal merge guard","authorization":"<verbatim authorized quote>","resume":{"pr":NUMBER}}
   Include this exact host-generated row binding on its own line in the PR body: agentrig-train-row:607f5563-3fc5-4101-8d9e-0546c55e7693
   ```

   The conductor copies the actual trusted Row.authorization; the placeholder
   above is not authority. Include the real PR, current head, base-pinned land
   inputs, live ledger and review/CI handoff. Ask this coordinator to dispatch
   `subagent` with `agent: "lander"` for that PR, not to merge itself.
4. The dispatched lander rechecks the unchanged land preconditions and uses the
   literal SHA-pinned merge command. Preserve its child ID, immutable spawn event,
   dispatch comment ID, hook/tool events and merge result in the PR handoff as
   evidence that this guard ran during this PR's own merge. Run normal post-merge
   main CI verification. Remove the temporary role and all owned landing scratch
   only after joining jobs and persisting the landing handoff.

A denial is not a waiver: fix the named missing authority/CI/provenance or
redispatch. The builder does not run this landing procedure or merge the PR.
Slice 3 still owns deletion of superseded manual bookkeeping prose.
