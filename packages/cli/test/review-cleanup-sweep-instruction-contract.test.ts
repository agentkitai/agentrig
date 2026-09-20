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
    const withoutNormalization = snippet.replace(/node -e '[^']*' "[^"]+-validated\.md"/, `cat "${out}/${reviewer}.md"`);
    expect(withoutNormalization).not.toBe(snippet);
    expect(spawnSync("/bin/sh", ["-c", withoutNormalization]).status).toBe(0);
    const comment = readFileSync(join(out, `${reviewer}-comment.md`), "utf8");
    // This mutant would fail the executable canonical-body contract above.
    expect(comment.match(/^## External review/gm)).toHaveLength(2);
    expect(comment).not.toContain("full\n\nverdict\n");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// #368: enforce order in each local halt path, not by a distant delegation.
for (const start of ["both reviewers dead\n", "one surviving review is not"]) {
  const check = (text: string) => {
    const local = section(text, start, "halt the train)").replace(/\s+/g, " ");
    const post = local.indexOf("post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR");
    const clean = local.indexOf("then remove both reviewer trees");
    expect(post).toBeGreaterThanOrEqual(0);
    expect(clean).toBeGreaterThan(post);
    expect(local).toContain("under **Review scratch cleanup**; only then");
  };
  it(`#368 local persist-before-delete ${start}`, () => {
    const text = read("topic");
    check(text);
    const mutant = text.replaceAll("post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR; then remove both reviewer trees", "then remove both reviewer trees; post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR");
    expect(mutant).not.toBe(text);
    expect(() => check(mutant)).toThrow();
  });
}
for (const reviewer of ["claude", "codex"]) {
  const run = (body: string, mutate: "bypass" | "heading-only" | undefined = undefined) => {
    const out = mkdtempSync(join(tmpdir(), "review-validation-"));
    try {
      writeFileSync(join(out, `${reviewer}.md`), body);
      writeFileSync(join(out, "codex-model.txt"), "gpt-test");
      writeFileSync(join(out, "codex-trio.md"), "proof cannot substitute for verdict");
      const prefix = reviewer === "claude" ? "CLAUDE_HEADING=" : "CODEX_MODEL=$(cat";
      const fence = reviewer === "claude" ? "```sh\n" : "```\n";
      let snippet = (prefix + section(read("topic"), fence + prefix, "```")).replaceAll("<OUT>", out).replaceAll("— head HEAD — merged with origin/main MAIN — full", `— head ${"a".repeat(40)} — merged with origin/main ${"b".repeat(40)} — full`).replace('"HEAD" >', `"${"a".repeat(40)}" >`);
      // Substitute only shell argument/heading placeholders, never node program text or variable names.
      const source = prefix + section(read("topic"), fence + prefix, "```");
      expect(snippet.match(/node -e '[^']*'/g)).toEqual(source.match(/node -e '[^']*'/g));
      if (mutate === "heading-only") {
        const clause = String.raw` || body.trim().split(/\r?\n/).every(l=>!l.trim() || /^#+(?:\s|$)/.test(l))`;
        expect(snippet.split(clause)).toHaveLength(2);
        snippet = snippet.replace(clause, "");
      }
      if (mutate === "bypass") {
        const original = snippet;
        snippet = snippet.replace(/node -e '[^']+' "[^"\n]+\.md" "a{40}" > "[^"\n]+" \|\| exit 2/, `cat "${out}/${reviewer}.md" > "${out}/${reviewer}-validated.md"`);
        expect(snippet).not.toBe(original);
      }
      const result = spawnSync("/bin/sh", ["-c", snippet], { encoding: "utf8" });
      return { status: result.status, comment: result.status === 0 ? readFileSync(join(out, `${reviewer}-comment.md`), "utf8") : "" };
    } finally { rmSync(out, { recursive: true, force: true }); }
  };
  const heading = (sha: string) => `## External review — duplicate — head ${sha} — merged with origin/main ${"b".repeat(40)} — full`;
  it.each(["", " \n\t", heading("a".repeat(40)), `${heading("c".repeat(40))}\nverdict`, `${heading("a".repeat(40))}\n${heading("c".repeat(40))}\nverdict`, `Reviewed SHA: ${"c".repeat(40)}\nverdict`])(`#369 ${reviewer} rejects invalid verdict %j`, body => {
    expect(run(body).status).toBe(2);
  });
  it.each([
    "Reviewed head", "reviewed head:", "Reviewed HEAD", "head", "Exact head reviewed:", "Reviewed SHA:",
  ])(`#369 C1 ${reviewer} accepts current claim after %s`, label => {
    expect(run(`${label} ${"a".repeat(40)}\nverdict`).status).toBe(0);
  });
  it.each([7, 12, 39, 40])(`#369 C2 ${reviewer} matches SHA prefix of length %i`, length => {
    expect(run(`Reviewed SHA: ${"A".repeat(length)}\nverdict`).status).toBe(0);
    expect(run(`Reviewed SHA: ${"a".repeat(length - 1)}c\nverdict`).status).toBe(2);
  });
  it.each(["Reviewed SHA: HEAD", "head HEAD", "Reviewed HEAD"])(`#369 C3 ${reviewer} rejects literal placeholder %s`, claim => {
    expect(run(`${claim}\nverdict`).status).toBe(2);
  });
  it.each([
    "# Verdict\n## Findings\n### Summary",
    `${heading("a".repeat(40))}\n## Findings`,
  ])(`#369 C4 ${reviewer} heading-only clause-deletion mutant: %j`, body => {
    expect(run(body).status).toBe(2);
    expect(run(body, "heading-only").status).toBe(0);
  });
  it.each(["**", "__", "`"])(`#369 X1 ${reviewer} checks Markdown %s claims before stripping`, mark => {
    for (const sha of ["a".repeat(40), "c".repeat(40)]) {
      for (const claim of [`Reviewed SHA: ${mark}${sha}${mark}`, heading(`${mark}${sha}${mark}`)]) {
        expect(run(`${claim}\nverdict`).status).toBe(sha.startsWith("a") ? 0 : 2);
      }
    }
  });
  it(`#369 ${reviewer} accepts matching SHA preserving canonical heading`, () => {
    const result = run(`${heading("a".repeat(40))}\n\nverdict\n`);
    expect(result.status).toBe(0);
    expect(result.comment).toContain(`— head ${"a".repeat(40)} — merged with origin/main ${"b".repeat(40)} — full\n\nverdict\n`);
    expect(result.comment.match(/^## External review/gm)).toHaveLength(1);
  });
  it(`#369 ${reviewer} validation-bypass mutant exposes stale and empty acceptance`, () => {
    for (const body of ["", `${heading("c".repeat(40))}\nverdict`]) expect(run(body, "bypass").status).toBe(0);
  });
}

// D1: the local Codex lead-in must not override the shared targeted-substitution rule.
const codexSubstitutionRule = 'Apply the same targeted substitution described above (only the `"HEAD"` shell argument and canonical heading spans) with the same recorded full SHAs:';
const staleCodexSubstitutionRule = "Replace HEAD and MAIN below with the same recorded full SHAs:";
const checkCodexSubstitution = (text: string) => {
  const lead = section(text, "For Codex, in the posting call", "```\nCODEX_MODEL=").replace(/\s+/g, " ");
  expect(lead).toContain(codexSubstitutionRule);
  expect(lead).not.toContain(staleCodexSubstitutionRule);
};
it("D1 Codex operative lead-in delegates only targeted substitution", () => checkCodexSubstitution(read("topic")));
it("D1-stale-Codex-lead-in mutant rejects conflicting prose even with appended correction", () => {
  const text = read("topic");
  checkCodexSubstitution(text);
  const mutant = text.replace(codexSubstitutionRule, staleCodexSubstitutionRule);
  expect(mutant).not.toBe(text);
  expect(() => checkCodexSubstitution(mutant + `\n${codexSubstitutionRule}`)).toThrow();
});
it("D1 global substitution corrupts Codex validation; targeted substitution rejects literal Reviewed head HEAD", () => {
  const out = mkdtempSync(join(tmpdir(), "codex-substitution-"));
  try {
    writeFileSync(join(out, "codex-model.txt"), "gpt-test");
    writeFileSync(join(out, "codex-trio.md"), "independent proof");
    const source = "CODEX_MODEL=$(cat" + section(read("topic"), "```\nCODEX_MODEL=$(cat", "```");
    const head = "a".repeat(40), main = "b".repeat(40);
    const targeted = source.replaceAll("<OUT>", out).replaceAll("— head HEAD — merged with origin/main MAIN — full", `— head ${head} — merged with origin/main ${main} — full`).replace('"HEAD" >', `"${head}" >`);
    const global = source.replaceAll("<OUT>", out).replaceAll("HEAD", head).replaceAll("MAIN", main);
    expect(targeted.match(/node -e '[^']*'/g)).toEqual(source.match(/node -e '[^']*'/g));
    expect(global.match(/node -e '[^']*'/g)).not.toEqual(source.match(/node -e '[^']*'/g));
    for (const [claim, expected] of [[head, 0], ["HEAD", 2]] as const) {
      writeFileSync(join(out, "codex.md"), `Reviewed head ${claim}\nverdict\n`);
      expect(spawnSync("/bin/sh", ["-c", targeted]).status).toBe(expected);
    }
    expect(spawnSync("/bin/sh", ["-c", global]).status).toBe(0);
    expect(readFileSync(join(out, "codex-comment.md"), "utf8")).toContain("Reviewed head HEAD\nverdict");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
