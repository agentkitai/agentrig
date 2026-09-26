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

## Read-only text and refusal rules (#587)

Literal `gh pr merge --help` and `-h` are reads, including in compound commands.
Help belongs to that invocation only: a later real merge is still guarded, and a
flag after `--` is not a help option. Quoted comment/printf text is data, not a
merge command. Quoting individual executable words does not hide a real merge.
The executable/subcommand selects the rule: `gh pr edit`, `gh pr comment`,
and issue/PR comment REST calls are not merges because of their quoted body,
body-file name or file contents (#619). Payload words such as `bash`, `node`,
`api` or `mergePullRequest` cannot reclassify that invocation. PR body edits
still undergo independent append-only ledger/source validation. Shell segments
and substitutions are checked separately, so a merge chained after an edit
remains refused. Leading assignments and recognized env/sudo/command/exec/
timeout/nice/nohup prefixes do not hide a merge; they are not accepted literal
merge forms. This does not interpret arbitrary wrapper programs.
Shell program arguments, command substitutions and recognized interpreter/API
mutation payloads remain executable data; compound and wrapped real merges must
still use the standalone literal form above. This lexical distinction does not
extend the gate into a general shell or programming-language interpreter.

Refusals identify `merge guard` or `ledger integrity` separately and include the
respective accepted literal form (`gh pr merge NUMBER --squash --match-head-commit
FULL_HEAD` or `gh pr edit NUMBER --body-file FILE`). The shared literal-word parser
no longer labels merge syntax errors as body edits. Accepted syntax does not waive
authorization, head/CI verification, or append-only ledger/source checks.

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

## Lander command-form recovery

Run every `gh` command as one literal command without shell operators, pipes, or substitutions, including read-only commands. Prepare files and process output in separate tool calls.
If the ship-pack hook refuses a malformed non-merge command, correct the command to the accepted literal form named in the refusal and retry once. If that retry is refused, halt and report the exact reason. This retry is only a command-form correction, not permission to bypass a ledger refusal or change evidence.
If a bounded merge command is refused or any land gate fails, halt and report the exact reason; do not retry the merge or weaken the gate. Authorization, exact-head CI, dispatch binding, append-only ledger/source checks, review resolution, and post-merge CI remain required.

This landing instruction is deliberately stricter than the parser’s read-only help exemption (#587); it changes no hook predicate or accepted parser syntax. LOW observations and wording followups remain advisories under R19, not residual issues.
