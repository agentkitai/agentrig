# Minimal ship merge guard (R19f slice 2)

The ship dispatch extension composes its existing ledger-integrity handler with a
`pre_tool` merge guard. This is not a replacement for the land skill. Review
resolution, review evidence, mergeability, row completion and post-merge CI remain
with that skill, unchanged. The guard does not read or invent review evidence.

The initial host prompt's adjacent `Row: <JSON>` and host-generated row-binding
line provide the only authorization source. Later prompts cannot replace it.
The PR body must contain that exact authorization string on its own line and the own-line row
binding. LF and CRLF delimiters are accepted; quote bytes are never trimmed.
Prefix, suffix and whitespace edits are refused. A successful `pre_spawn` dispatch posts and reads back the existing
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
last read. No deferred `--auto` merge is authorized by a transient green result;
`--admin` and `--disable-auto` are also refused. Branch protection may not be
bypassed. Recognized literal inline GraphQL merge mutations, curl merge calls,
and REST merge calls using input files are refused, as are recognized merge
commands wrapped with shell operators; use the literal REST or PR form above.

Like ledger integrity this is a bounded command gate, not a shell sandbox or a
GitHub transaction. Indirect scripts or dynamically constructed commands are not
interpreted, and GitHub branch protection must remain enabled. Branch protection
is also the backstop against check results changing after the final read. Ordinary
reads and unrelated tools remain unchanged. The API/CLI fetch budget is 25s,
below the registered 30s hook deadline.

## Slice-2 boundary and landing correction

The slice-2 guard is a textual command backstop, not a shell sandbox or a payload interpreter. It guards recognized literal merge commands; constructed commands and merge operations hidden in file-referenced API payloads are not inspected. It does not promise universal GraphQL or arbitrary-shell merge interception. This limitation is explicit; review resolution and remote branch protection remain separate controls.

This documentation-only boundary correction is approved by arbiter child
`61381213`; it does not change the three predicates or land/review rules.

The operator withdrew the requirement that PR #585 land through its own new
guard: the running host is built from main and cannot hot-reload this change.
PR #585 instead lands through the existing land skill after its normal review
and exact-head CI gates. The next row (052) is the first live guard exercise,
to be verified by the operator. No self-landing guard exercise is claimed.
This replaces the obsolete nested-host self-landing procedure; it does not
instruct a conductor to launch another host from bash.

When the guard is active, a denial is not a waiver: fix the named missing
authority/CI/provenance or redispatch. The builder does not merge.
Slice 3 retires superseded manual bookkeeping prose while preserving land review-resolution
judgment. Its PR ledger leaves the first real guarded merge decision pending for the lander;
builder fixture passes are not a live landing receipt.
