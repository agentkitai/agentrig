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
});

it("topic launches Codex in its own tree and temp root for full and delta passes", async () => {
  const text = await skill("topic");
  expect(text).toContain('git worktree add --detach "$CODEX_WT" "$(git -C "$WT" rev-parse HEAD)"');
  expect(text).toContain('git worktree add --detach "$CODEX_WT" "$NEW"');
  expect(text).toContain("cd <CODEX_WT> && TMPDIR=<OUT>/codex-tmp codex review");
  expect(text).toContain("TMPDIR=<OUT>/claude-tmp claude -p");
  expect(text).not.toContain("cd <WT> && codex review");
  expect(text).toContain("m.length!==1||m[0]!==\"claude-opus-5\"");
});
