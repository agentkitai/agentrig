import { instructionSource } from "../../cli/test/instruction-source.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const skill = (name: string) => instructionSource(`.agentrig/skills/${name}/SKILL.md`);

it("CLI adapter permits explicit mutation tools without plan mode or bypass", () => {
 const text = readFileSync(new URL("../../../scripts/review-adapters.mjs", import.meta.url), "utf8");
 expect(text).toContain("--permission-mode dontAsk");
 expect(text).toContain("env -u CLAUDECODE");
 expect(text).toContain("< /dev/null");
 expect(text).toContain("--allowedTools 'Read,Grep,Glob,Bash,Edit,Write'");
 expect(text).toContain("--disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)'");
 expect(text).not.toMatch(/bypassPermissions|dangerously-skip-permissions/);
});
it("topic launches only declared slots in separate trees and temp roots after preparation", () => {
 const text = skill("topic");
 for (const phrase of ["one separate owned worktree per declared slot", "independent temporary roots", "before launching any reviewer job", "command-local TMPDIR", "Record job IDs and UTC start times immediately", "actual model equals the configured pin", "unchanged HEAD and restored tracked/index state", "Strip each owned worktree prefix"]) expect(text).toContain(phrase);
 expect(text).not.toMatch(/claude|codex|opus|gpt-/i);
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
  expect(await skill("ship")).toContain("topic §2 step 4");
  expect(await skill("dogfood")).toContain("topic §2 step 4");
});
