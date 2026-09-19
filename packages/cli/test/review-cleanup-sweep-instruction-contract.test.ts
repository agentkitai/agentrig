import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const read = (skill: string) => readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => {
  expect(text.split(start)).toHaveLength(2);
  const rest = text.split(start)[1]!;
  expect(rest).toContain(end);
  return rest.split(end)[0]!;
};
const contracts = [
  ...[
    ["Operative resource mapping:", "Apply this sequence"],
    ["PR head)` (remove", "conflict is a finding"],
    ["conflict is a finding", "A pass that stopped"],
    ["  persist the verdict/receipts", "- **Converge:**"],
    ["4. Remove only", "For a focused pass"],
    ["For a focused pass", "## 1."],
    ["normal because the jobs", "A pass with"],
    ["one surviving review is not", "   - **Assert the model"],
    ["   - **Provenance.", "Compose each comment body"],
    ["their receipts first.", "   - **Combine."],
  ].map(([start, end]) => ({ skill: "topic", start: start!, end: end!, issue: 341, phrases: ["conductor-trio tree", "conductor-trio temporary root"] })),
  { skill: "topic", start: "   - **Conductor trio", end: "   - **Wait**", issue: 342, phrases: ["including any retry", "before executing in its tree", "before posting", "all Codex attempts and subprocesses have completed"] },
  ...["dogfood", "ship"].map(skill => ({ skill, start: "## 1.", end: "## 2.", issue: 348, phrases: ["git worktree remove <path>", "then `git worktree prune`", "Never use bare directory deletion"] })),
  ...[
    ["## 7.", "## 8.", ["record the phase handoff in the PR body", "remove the owned builder worktree and proof TMPDIR", "before starting §8"]],
    ["## 8.", "## 9.", ["After §7's persisted phase handoff and builder cleanup", "outside the removed builder tree"]],
    ["## 9.", "## 10.", ["attach the existing branch in an owned worktree per §1", "push", "record a new phase handoff in the PR body", "repeat builder worktree and proof TMPDIR cleanup", "before resuming review"]],
    ["## 10.", "- When the supervisor", ["outside the removed builder tree", "Do not retain or recreate the builder tree while waiting"]],
  ].map(([start, end, phrases]) => ({ skill: "dogfood", start: start as string, end: end as string, issue: 349, phrases: phrases as string[] })),
];
for (const { skill, start, end, issue, phrases } of contracts) {
  const check = (text: string) => {
    const operative = section(text, start, end).replace(/\s+/g, " ");
    for (const phrase of phrases) expect(operative).toContain(phrase);
  };
  it(`#${issue} ${skill} ${start}`, () => check(read(skill)));
  it.each(phrases)(`#${issue} rejects removed operative instruction: %s (${start})`, phrase => {
    const text = read(skill);
    check(text);
    const body = section(text, start, end);
    const mutant = body.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")), "REMOVED");
    expect(mutant).not.toBe(body);
    expect(() => check(text.replace(body, mutant) + `\n${phrase}`)).toThrow();
  });
}

for (const skill of ["ship", "topic"]) {
  const spawn = skill === "ship" ? "- Spawn the fixer" : "- **Fix** with one subagent";
  const check = (text: string) => {
    const operative = section(text, "## 3.", "## 4.");
    const edit = operative.indexOf("1. Persist the PR body with `gh pr edit");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(operative.indexOf(spawn)).toBeGreaterThan(edit);
    const ledger = operative.slice(edit, operative.indexOf(spawn)).replace(/\s+/g, " ");
    for (const phrase of ["## Review disposition", "every finding", "severity", "disposition", "Repair round: N/3", "OLD", "assigned blocker IDs", "## Residuals", "links or none", "Require edit success before proceeding", "2. Only then"]) expect(ledger).toContain(phrase);
  };
  it(`#351 ${skill} persists ledger before fixer`, () => check(read(skill)));
  it(`#351 ${skill} rejects prescribed spawn before ledger edit`, () => {
    const text = read(skill);
    check(text);
    const at = text.indexOf(spawn);
    const end = text.indexOf("\n- ", at + 1);
    const instruction = text.slice(at, end);
    const mutant = text.replace(instruction, "").replace("1. Persist the PR body", `${instruction}\n1. Persist the PR body`);
    expect(() => check(mutant)).toThrow();
  });
}

for (const reviewer of ["claude", "codex"]) {
  it.each(["verdict\n", "\n\nverdict\n", "\n## External review — duplicate\n\nverdict\n", "\n## External review — duplicate\n\n## External review — another\nverdict\n"])(`#365 ${reviewer} canonical first line and normalized body: %j`, body => {
    const out = mkdtempSync(join(tmpdir(), "review-heading-"));
    try {
      writeFileSync(join(out, `${reviewer}.md`), body);
      writeFileSync(join(out, "codex-model.txt"), "gpt-test");
      writeFileSync(join(out, "codex-trio.md"), "independent proof");
      const text = read("topic");
      const snippet = section(text, reviewer === "claude" ? "```sh\nCLAUDE_HEADING=" : "```\nCODEX_MODEL=$(cat", "```");
      const prefix = reviewer === "claude" ? "CLAUDE_HEADING=" : "CODEX_MODEL=$(cat";
      const result = spawnSync("/bin/sh", ["-c", (prefix + snippet).replaceAll("<OUT>", out)], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const comment = readFileSync(join(out, `${reviewer}-comment.md`), "utf8");
      const heading = `## External review — ${reviewer === "claude" ? "Claude Code (claude-opus-5)" : "Codex (gpt-test)"} — head HEAD — merged with origin/main MAIN — full`;
      expect(comment.split("\n")[0]).toBe(heading);
      expect(comment).toContain(`${heading}\n\nverdict\n`);
      expect(comment.match(/^## External review/gm)).toHaveLength(1);
      expect(snippet).toContain('head -1');
      expect(snippet).toContain('|| exit 2');
      expect(text.indexOf(prefix + snippet)).toBeLessThan(text.indexOf(`gh pr comment NN --body-file "<OUT>/${reviewer}-comment.md"`));
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
}

it.each(["claude", "codex"])("#365 %s assertion rejects a damaged first line before posting", reviewer => {
  const out = mkdtempSync(join(tmpdir(), "review-heading-mutation-"));
  try {
    writeFileSync(join(out, `${reviewer}.md`), "\n## External review — duplicate\nverdict\n");
    writeFileSync(join(out, "codex-model.txt"), "gpt-test");
    writeFileSync(join(out, "codex-trio.md"), "proof");
    const prefix = reviewer === "claude" ? "CLAUDE_HEADING=" : "CODEX_MODEL=$(cat";
    const fence = reviewer === "claude" ? "```sh\n" : "```\n";
    const snippet = (prefix + section(read("topic"), fence + prefix, "```" )).replaceAll("<OUT>", out);
    const damaged = snippet.replace('[ "$(head -1', `printf '\\n' > "${out}/${reviewer}-comment.md"\n[ "$(head -1`);
    expect(damaged).not.toBe(snippet);
    expect(spawnSync("/bin/sh", ["-c", damaged]).status).toBe(2);
    const withoutNormalization = snippet.replace(/node -e '[^']*' "[^"]+"/, `cat "${out}/${reviewer}.md"`);
    expect(withoutNormalization).not.toBe(snippet);
    expect(spawnSync("/bin/sh", ["-c", withoutNormalization]).status).toBe(0);
    const comment = readFileSync(join(out, `${reviewer}-comment.md`), "utf8");
    // This mutant would fail the executable canonical-body contract above.
    expect(comment.match(/^## External review/gm)).toHaveLength(2);
    expect(comment).not.toContain("full\n\nverdict\n");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
