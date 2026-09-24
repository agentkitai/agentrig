import { readSkillText } from "../../../test/skill-text.js";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const skill = (name: string) => readSkillText(new URL(`../../../.agentrig/skills/${name}/SKILL.md`, import.meta.url), "utf8");

it("dogfood delegates launch permissions to the canonical adapter", async () => {
  const text = await skill("dogfood");
  const initial = text.split("## 8.")[1]!.split("## 9.")[0]!;
  expect(initial).toContain("topic §2 step 4");
  expect(initial).toContain("scripts/reviewer-adapters.mjs");
  expect(initial).not.toMatch(/claude -p|codex exec|bypassPermissions|dangerously-skip-permissions/);
});

it("topic permits explicit mutation tools without plan mode or bypass", async () => {
  const text = await skill("topic");
  const adapters = await readFile(new URL("../../../packs/ship/scripts/reviewer-adapters.mjs", import.meta.url), "utf8");
  expect(text).toContain("Launch each slot through its adapter");
  expect(text).toContain("node <REPO>/scripts/reviewer-adapters.mjs");
  expect(adapters).toContain('"--permission-mode", "dontAsk"');
  expect(adapters).toContain('"--allowedTools", "Bash,Read,Glob,Grep,Edit,Write"');
  expect(adapters).toContain('"--sandbox", "workspace-write"');
  expect(adapters).toContain('"--disallowedTools", "Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)"');
  expect(text).toContain("It forbids push, merge, commit, permission changes, children and auxiliary models");
  expect(text + adapters).not.toMatch(/--permission-mode[" ,]+plan|--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/);
});

it("topic launches the initial pair in separate trees and temp roots", async () => {
  const text = await skill("topic");
  const initial = text.slice(text.indexOf("4. Run the **external review pass**"), text.indexOf("5. Record")).replace(/\s+/g, " ");
  expect(initial).toContain("Zero slots: persist `External review: none declared`, skip all reviewer preparation/dispatch");
  expect(initial).toContain("One slot: only one tree, job and heading");
  expect(initial).toContain("one exclusive reviewer-owned tree per slot");
  expect(initial).toContain("Create one independent TMPDIR outside Git ancestry per job");
  expect(initial).toContain("Never share mutable sources, build output or node_modules");
  expect(initial).toContain("assert each tree HEAD equals current PR HEAD and is clean");
  expect(initial).toContain('git merge-base --is-ancestor "$MAIN" "$HEAD"');
  expect(initial).toContain("Require each command's exit code zero in each reviewer tree before launching any reviewer job");
  expect(initial).toContain("Empty steps run no commands, including bootstrap/preflight");
  expect(initial).toContain("On any failure halt before launch");
  expect(initial.indexOf("Require GREEN BEFORE launching any reviewer")).toBeGreaterThan(-1);
  expect(initial.indexOf("node <REPO>/scripts/reviewer-adapters.mjs")).toBeGreaterThan(initial.indexOf("Require GREEN BEFORE launching any reviewer"));
  expect(initial).toContain("TMPDIR=<SLOT_TMP>");
  expect(initial).toContain("Never pass the builder's report, findings or reasoning as evidence");
  expect(initial).toContain("A conflict-stopped initial pass restarts as full, not delta");
  expect(text).toContain("With two slots launch\nboth independently");
  expect(text).toContain("that same slot is the focused-delta reviewer");
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
  expect(await skill("dogfood")).toContain("create a detached worktree per slot");
  expect(await skill("dogfood")).toContain("outside the removed builder tree");
});
