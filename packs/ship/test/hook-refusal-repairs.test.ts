import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(resolve(`packs/ship/extensions/${name}.mjs`)).href);
const { mergeIntent, createMergeGuard } = await load("merge-guard");
const { ledgerEditIntent, createLedgerHook } = await load("ledger-integrity");
const context = (command: string) => ({ cwd: process.cwd(), sessionId: "unprivileged", tool: { name: "bash", input: { command } } });
const merge = createMergeGuard();
const ledger = createLedgerHook();
async function denied(command: string, rule: "merge" | "ledger") {
  expect((rule === "merge" ? mergeIntent : ledgerEditIntent)(command)).toBe(true);
  const result = await (rule === "merge" ? merge : ledger)(context(command));
  expect(result.action).toBe("deny");
  expect(result.reason).toContain(rule === "merge" ? "merge guard" : "ledger integrity");
  expect(result.reason).toContain(rule === "merge" ? "gh pr merge NUMBER" : "gh pr edit NUMBER");
}
describe("repair blockers #587", () => {
  it.each(["--subject", "-t", "--body", "-b", "--author-email", "-A"].flatMap(flag => ["--help", "-h"].map(help => [flag, help])))('C1 help consumed by %s as %s is a real merge', async (flag, help) => {
    await denied(`gh pr merge 7 --squash --match-head-commit ${"a".repeat(40)} ${flag} ${help}`, "merge");
  });
  it.each(["https://api.github.com/repos/o/r/pulls/7", "https://github.example/api/v3/repos/o/r/pulls/7"])('C2 absolute PATCH refuses unsupported form %s', async endpoint => {
    await denied(`gh api ${endpoint} -X PATCH -f body=replaced`, "ledger");
    const result = await ledger(context(`gh api ${endpoint} -X PATCH -f body=replaced`));
    expect(result.reason).toContain("unsupported pulls API command");
    expect(await ledger(context(`gh api ${endpoint} -X GET`))).toEqual({ action: "continue" });
  });
  it.each(["csh", "/bin/tcsh", "fish"])('C3 shell wrapper %s guards both mutations', async shell => {
    await denied(`${shell} -c 'gh pr merge 7'`, "merge");
    await denied(`${shell} -c 'gh pr edit 7 --body replaced'`, "ledger");
    await denied(`${shell} -c 'gh pr merge 7 --subject --help'`, "merge");
    await denied(`${shell} -c 'gh api https://api.github.com/repos/o/r/pulls/7 -X PATCH -f body=replaced'`, "ledger");
    expect(await merge(context(`${shell} -c 'gh pr merge --help'`))).toEqual({ action: "continue" });
  });
  it.each([
    `echo "$(printf '%s' "$(pwd)"; MUTATION)"`,
    `echo "$(printf '%s' "$(echo "$(pwd)")"; MUTATION)"`,
    `echo "$(printf '%s' ')'; MUTATION)"`,
    `echo "$(printf '%s' \\); MUTATION)"`,
    `echo "$( (pwd); MUTATION)"`,
  ].flatMap(template => (["merge", "ledger"] as const).map(rule => ({ template, rule }))))('X1 balanced substitutions guard $rule: $template', async ({ template, rule }) => {
    await denied(template.replace("MUTATION", rule === "merge" ? "gh pr merge 7" : "gh pr edit 7 --body replaced"), rule);
    await denied(template.replace("MUTATION", rule === "merge" ? "gh pr merge 7 --body -h" : "gh api https://api.github.com/repos/o/r/pulls/7 -X PATCH -f body=replaced"), rule);
  });
  it.each([
    "gh pr merge --help", "gh pr merge 7 -h", "gh pr merge --help https://github.com/o/r/pull/7",
    `echo "$(printf '%s' "$(pwd)"; gh pr merge --help)"`,
    `echo '$(printf "%s" "$(pwd)"; gh pr merge 7)'`,
    `echo "$(printf '%s' 'gh pr merge 7')"`,
    `printf '%s' 'gh api https://api.github.com/repos/o/r/pulls/7 -X PATCH -f body=replaced'`,
  ])('read-only boundaries continue: %s', async command => {
    expect(await merge(context(command))).toEqual({ action: "continue" });
    expect(await ledger(context(command))).toEqual({ action: "continue" });
  });
});
