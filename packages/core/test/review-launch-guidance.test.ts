import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const skill = (name: string) => readFile(new URL(`../../../.agentrig/skills/${name}/SKILL.md`, import.meta.url), "utf8");

it.each(["topic", "dogfood"])("%s permits explicit mutation tools without plan mode or bypass", async name => {
  const text = await skill(name);
  const launches = text.split("\n").filter(line => line.includes("claude -p --model"));
  expect(launches).toHaveLength(1);
  expect(launches[0]).toContain("--permission-mode dontAsk");
  expect(launches[0]).toContain("--allowedTools 'Read,Grep,Glob,Bash,Edit,Write'");
  expect(launches[0]).toContain("--model claude-opus-5");
  expect(launches[0]).not.toMatch(/bypassPermissions|dangerously-skip-permissions/);
  expect(text).toContain("--disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)'");
});

it("topic launches the initial pair in separate trees and temp roots", async () => {
  const text = await skill("topic");
  expect(text).toContain('REVHEAD=$(git -C "$WT" rev-parse HEAD)');
  expect(text).toContain('git worktree add --detach "$CODEX_WT" "$REVHEAD"');
  expect(text).toContain("cd <CODEX_WT> && TMPDIR=<OUT>/codex-tmp codex review");
  expect(text).toContain("TMPDIR=<OUT>/claude-tmp claude -p");
  expect(text).not.toContain("cd <WT> && codex review");
  expect(text).toContain("m.length!==1||m[0]!==\"claude-opus-5\"");
  expect(text).toContain('End preparation with `echo "$WT" "$CODEX_WT" "$OUT" "$REVHEAD"`');
  expect(text).toContain("the recorded `<REVHEAD>` (post-merge on a full pass; NEW on a delta)");
  expect(text).toContain("One `bash` call for preparation, then one call per install.");
  expect(text.replace(/\s+/g, " ")).toContain("Record these paths and the post-merge review SHA BEFORE installing dependencies.");
  expect(text).toContain("in separate calls, each with `timeoutMs` at least 600000");
  expect(text).toContain("Strip `<CODEX_WT>/` from Codex file:line locations and `<WT>/` from Claude's");
});

/**
 * §3's delta bullet only. The full-pass preparation in §2 step 4 says the same things in different
 * words, so a delta assertion written against the whole file passes even after the delta paragraph
 * is deleted — the gap #253 recorded. Everything below reads this slice, never the file.
 */
async function deltaPass() {
  const text = await skill("topic");
  const start = text.indexOf("- **Cover the delta**");
  const end = text.indexOf("\n- **Converge:**", start);
  expect(start, "delta bullet").toBeGreaterThanOrEqual(0);
  expect(end, "convergence bullet after the delta bullet").toBeGreaterThan(start);
  return text.slice(start, end).replace(/\s+/g, " ");
}

it("the delta bullet is pinned apart from the full-pass preparation", async () => {
  const delta = await deltaPass();
  expect(delta).toContain("Material deltas require ONE independent focused reviewer");
  expect(delta).toContain('git worktree add --detach "$WT" "$NEW"');
  expect(delta).toContain("The delta pass does not merge main");
  expect(delta).toContain("restored tracked/index state");
  expect(delta).toContain("A dead focused review after retry halts");
  expect(delta).not.toContain("$CODEX_WT");
});

it("delta preparation ends by echoing what the next calls must be given", async () => {
  expect(await deltaPass()).toContain("End preparation with `echo ");
});

it("the delta echo tuple carries the one tree, output, reviewed head and unique base", async () => {
  expect(await deltaPass()).toContain('echo "$WT" "$OUT" "$REVHEAD" "$BASE"`, record the paths/SHA/ref');
});

it("delta dependencies install separately with a deadline and a successful exit gate", async () => {
  expect(await deltaPass()).toContain(
    "Install dependencies in a separate call with timeoutMs at least 600000; require exit code zero before launch");
});

it("ship and standalone dogfood preserve separate trees and explicit launch locations", async () => {
  expect(await skill("ship")).toContain("in parallel in separate reviewer-owned worktrees you prepare");
  expect(await skill("dogfood")).toContain("cd <WT> && TMPDIR=<OUT>/claude-tmp claude -p");
});
