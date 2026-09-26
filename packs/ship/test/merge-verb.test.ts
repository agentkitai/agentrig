import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { mergeIntent, createMergeGuard } = await import(/* @vite-ignore */ pathToFileURL(resolve("packs/ship/extensions/merge-guard.mjs")).href);
const guard = createMergeGuard();
const check = (command: string) => guard({ cwd: process.cwd(), sessionId: "unprivileged", tool: { name: "bash", input: { command } } });
describe("merge classification by executable verb #619", () => {
  const payloads = ["gh pr merge <n> --squash --match-head-commit <verified SHA>", "pr", "merge", "bash", "node", "api", "mergePullRequest", "repos/o/r/pulls/7/merge", "gh pr merge 7 && gh pr merge 8", "line one\r\n gh pr merge 7", ""];
  it.each(payloads.flatMap(body => [
    `gh pr edit 52 --body '${body}'`,
    `gh pr comment 52 --body '${body}'`,
    `gh api repos/o/r/issues/52/comments -f 'body=${body}'`,
    `gh api repos/o/r/pulls/52/comments -f 'body=${body}'`,
    `gh pr edit 52 --body '${body}' --title 'gh pr merge 7'`,
  ]))("payload is not executable: %s", async command => {
    expect(mergeIntent(command)).toBe(false);
    expect(await check(command)).toEqual({ action: "continue" });
  });
  it.each([
    `gh pr edit 52 --body 'gh pr merge 7' --title bash`,
    `gh pr comment 52 --body 'mergePullRequest' --repo api`,
    `gh api repos/o/r/issues/52/comments -f 'body=mergePullRequest'`,
    `gh pr edit 52 --body-file 'gh pr merge 7'`,
    `gh pr comment 52 --body-file 'repos/o/r/pulls/7/merge'`,
    `printf '%s' pr merge`, `echo api repos/o/r/pulls/7/merge`,
    `printf '%s' bash 'gh pr merge 7'`,
    `gh pr edit 52 --body "quoted \\"gh pr merge 7\\""`,
    `\r\n\r\ngh pr comment 52 --body 'gh pr merge 7'\r\n`,
    `gh -R o/r pr comment 52 --body 'gh pr merge 7'`,
    `gh pr comment 52 --body '$(gh pr merge 7)'`,
    `gh api --silent -f 'body=mergePullRequest' repos/o/r/issues/52/comments`,
    `gh api repos/o/r/issues/52/comments --input repos/o/r/pulls/7/merge`,
    `gh api --input repos/o/r/pulls/7/merge repos/o/r/issues/52/comments`,
    `gh api repos/o/r/pulls/comments/52 -X PATCH -f 'body=mergePullRequest'`,
  ])("data boundaries continue: %s", async command => {
    expect(mergeIntent(command)).toBe(false);
    expect(await check(command)).toEqual({ action: "continue" });
  });
  it.each([
    `gh pr edit 52 --body 'gh pr merge 7' && gh pr merge 52`,
    `gh pr comment 52 --body safe; gh pr merge 52`,
    `gh api repos/o/r/issues/52/comments -f body=safe\r\ngh pr merge 52`,
    `gh pr edit 52 --body "$(gh pr merge 52)"`,
    `gh pr comment 52 --body "\`gh pr merge 52\`"`,
    `sh -c 'gh pr edit 52 --body safe && gh pr merge 52'`,
    `env GH_HOST=github.com gh pr merge 52`, `sudo gh pr merge 52`,
    `GH_HOST=github.com gh pr merge 52`,
    `command gh pr merge 52`, `exec gh pr merge 52`,
    `timeout 10 gh pr merge 52`, `nice -n 2 gh pr merge 52`, `nohup gh pr merge 52`,
    `env /bin/bash -c 'gh pr merge 52'`,
    `gh -Ro/r pr merge 52`,
    `curl https://api.github.com/graphql -d 'mutation { mergePullRequest(input:{}) {clientMutationId}}'`,
    `gh -R o/r pr merge 52`, `gh --repo=o/r pr merge 52`,
    `gh pr merge 52 --body 'gh pr edit 52'`,
    `gh api repos/o/r/pulls/52/merge -X PUT -f sha=bad`,
    `gh api graphql -f 'query=mutation { mergePullRequest(input:{}) {clientMutationId}}'`,
    `curl https://api.github.com/repos/o/r/pulls/52/merge -X PUT`,
    `node -e 'execSync("gh pr merge 52")'`,
    `gh pr merge`, `gh pr merge 52 --body 'unterminated`,
    `xargs gh pr merge 52`, `docker run image gh pr merge 52`,
    `sudo -u node gh pr merge 52`, `sudo -u gh gh pr merge 52`,
    `if true; then gh pr merge 52; fi`, `! gh pr merge 52`,
    `gh api https://api.github.com/graphql -f 'query=mutation { mergePullRequest(input:{}) {clientMutationId}}'`,
    `gh api --input repos/payload.json repos/o/r/pulls/52/merge -X PUT`,
    `gh api --silent --input=payload.json repos/o/r/pulls/52/merge -X PUT`,
    `gh api repos/o/r/pulls/52/merge extraneous -X PUT`,
    `gh api -H repos/header repos/o/r/pulls/52/merge -X PUT`,
    `gh api -f query=mutation graphql --input repos/payload.json -f 'x=mergePullRequest'`,
  ])("actual merges remain refused: %s", async command => {
    expect(mergeIntent(command)).toBe(true);
    expect((await check(command)).action).toBe("deny");
  });
});
