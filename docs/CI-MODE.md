# CI / bot mode

`agentrig run --ci` uses the normal agent, configured providers and permissions. It
does not supply an approval or hosted runner. CI rejects effective `yolo` /
`dangerouslySkipPermissions`, never opens a prompt, and stops with nonzero exit on
an unresolved permission ask. Already-running cooperative work is cancelled and
joined using the existing runtime; this is not hostile-process containment.

```sh
agentrig run --ci --task-file task.txt --report report.md --trust --profile ci
agentrig run --ci --event-file event.json --event-field comment.body --report report.md --trust --profile ci
```

Choose exactly one source. Plain task text is at most 16 KiB; event JSON is at most
256 KiB and depth 16, selecting only `issue.body`, `comment.body` or
`pull_request.body` (a nonblank string of at most 16 KiB). Inputs must be regular,
non-symlink UTF-8 files. No implicit environment/event lookup, expression expansion,
payload-derived configuration, PR target, checkout or shell execution occurs.
Even a task file is advisory data: the runtime receives an empty user task plus
separately labelled advisory context, not fabricated fresh user approval.
Effective `--json` and `--verbose` refuse in CI: ordinary raw/chat rendering bypasses
the bounded redacted-report shape. Use ordinary `run` for those output modes.
These flags are not project-config fields; unknown config keys already fail closed.

CI clamps configured execution to **20 turns, five minutes and 50,000 main-model
tokens**; smaller values win. Existing priced USD/per-response validation applies.
These are existing runtime bounds, not a hard total auxiliary/child/remote billing
cap. Provider retries, missing usage and independently budgeted work retain their
existing uncertainty. Normal trusted configuration can enable memory, supervisor,
extensions and MCP startup; CI is not an implicit sandbox or feature-disable mode.
Use a dedicated audited config/profile, and do not assume an omitted profile field
removes an inherited setting.

For example, a dedicated clean project config can contain:

```json
{
  "profiles": {
    "ci": {
      "provider": "openai", "model": "YOUR_APPROVED_MODEL",
      "allow": ["read"], "deny": ["write", "exec", "net", "network", "subagent"],
      "maxTurns": 10, "maxMinutes": 2, "maxTokens": 20000,
      "supervise": false, "subagents": false,
      "ingestOnEnd": false, "dreamOnEnd": false,
      "extension": [], "extensionDiscovery": false, "packages": false,
      "skills": [], "skillDiscovery": false, "generatedSkills": false
    }
  }
}
```

Audit base/global configuration too, especially any `mcpConfig`, custom provider
endpoint or trusted host code. Provider access is the explicitly configured model
connection; tool `net` permission does not itself authorize or price that connection.

## Reports and comments

`--report` is an explicit host output request, separate from model tool-write
authority. It exclusively creates a file under a canonical existing parent; it
never creates parent directories or overwrites an occupied/symlink target. The
file is reserved before provider work. Early source/runtime failures produce a
failure report; an uncatchable kill, crash or I/O failure may leave an empty/partial
reservation. Such a file is **not success**; inspect exit status and the report.

Reports are at most 64 KiB: fixed outcome/usage/limit/refusal fields plus at most
16 KiB captured from the latest assistant turn, with a separate 32 KiB rendered
cap after redaction/escaping, shown as inert text. Omitted content and
partial/unknown accounting are explicit. Raw task/tool/error payloads are not
copied, and append-only session logs are never scrubbed or rewritten. Report-only
heuristic redaction can miss arbitrary secrets; review before wider publication.
`done` means runtime completion, not independently verified task correctness.

```sh
agentrig run --ci --task-file task.txt --report report.md \
  --repo owner/repository --pr 12 --comment --allow exec --allow net
```

Commenting is never automatic. The full explicit target is required and is not
read from the event. Every `gh` metadata read and comment needs both configured
exec and net authorization; asks deny. An enforcing sandbox refuses host `gh`.
Repository, number and base/head are pinned before the run and rechecked before
one fixed-argv stdin-body comment. Changed identity, cancellation, incomplete
accounting or omitted assistant output refuses publication. Check-and-post is
point-in-time, not atomic; a remote update can still race the final request.
Comment-only failures emit a safe diagnostic, never an implicit local report.

## One GitHub Actions example (not installed)

Adapt this explicitly; it is documentation, not a hosted service or default
deployment. Configure the dedicated profile above in a trusted commit containing
R15f, replace the all-zero checkout ref with that literal full commit SHA, and
approve the provider credential/spend yourself. Do not use a PR/event-supplied ref.
The example sends issue-comment text as data, never into a shell expression. It
does not grant comment permission or automatically act on a contributor's checkout.

```yaml
name: Explicit AgentRig CI example
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
concurrency:
  group: agentrig-ci-example
  cancel-in-progress: false
jobs:
  report:
    if: github.event.comment.author_association == 'OWNER'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: '0000000000000000000000000000000000000000' # REPLACE with reviewed trusted commit
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Produce bounded local report
        env:
          OPENAI_API_KEY: ${{ secrets.AGENTRIG_CI_OPENAI_API_KEY }}
        run: >-
          node packages/cli/dist/index.js run --ci
          --event-file "$GITHUB_EVENT_PATH" --event-field comment.body
          --report "$RUNNER_TEMP/agentrig-report.md" --trust --profile ci
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        if: always()
        with:
          name: agentrig-ci-report
          path: ${{ runner.temp }}/agentrig-report.md
          if-no-files-found: warn
          retention-days: 7
```

Action SHAs were resolved from each upstream repository's v4 tag during this row;
review and maintain pins before deployment. GitHub's primary
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
explains least-privilege tokens, immutable action pins and untrusted checkout/input
risks; [issue_comment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment)
describes the event/default-branch behavior. Author association is a workflow entry
filter, not a runtime permission grant or evidence that comment text is safe.
