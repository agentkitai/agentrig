import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readSkillText } from "../../../test/skill-text.js";
import { preservedReviews } from "./preserved-review-455.js";
// @ts-expect-error standalone helper
import { verdictBlock } from "../../../scripts/review-verdict.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const head = "a".repeat(40);
const topic = readSkillText(join(root, ".agentrig/skills/topic/SKILL.md"));
const line = topic.split("\n").find(line => line.includes("--validate '<PREFIX>.verdict.md'"))!.trim();
it.each(preservedReviews.map((prose, i) => [i, prose] as const))("PR455 output %s uses schema not prose", (_, prose) => {
  const dir = mkdtempSync(join(tmpdir(), "schema-shell-"));
  try {
    const prefix = join(dir, "review");
    for (const stale of [false, true]) {
      writeFileSync(`${prefix}.verdict.md`, prose + "\n" + verdictBlock({version:1, reviewedHead:stale ? "c".repeat(40) : head, slot:"Codex", assertedModel:"gpt-5.5", modelSource:"codex-launch", verdict:"PASS", findings:[]}));
      const script = line.replaceAll("<REPO>", root).replaceAll("<PREFIX>", prefix).replace("'HEAD'", `'${head}'`).replace("<SLOT>", "Codex").replace("<MODEL>", "gpt-5.5");
      const result = spawnSync("/bin/sh", ["-ec", script], {encoding:"utf8"});
      expect(result.status, result.stderr).toBe(stale ? 2 : 0);
      if (stale) expect(result.stderr).toContain("reviewedHead mismatch");
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
it.each(["ship", "topic"])("%s routes all initial/focused review through base schema gate", name => {
  const text = readSkillText(join(root, `.agentrig/skills/${name}/SKILL.md`));
  expect(text).toContain("base-pinned");
  expect(text).toContain("40 KiB");
  expect(text).not.toContain("const claimText=");
});
