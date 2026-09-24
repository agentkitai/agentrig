import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readSkillText } from "../../../test/skill-text.js";
import { preservedReviews } from "./preserved-review-455.js";
// @ts-expect-error standalone helper
import { verdictBlock, parseVerdict } from "../../../scripts/review-verdict.mjs";
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
      writeFileSync(`${prefix}.provenance.json`, JSON.stringify({ exit:0, reviewedHead:head, slot:"Codex", model:"gpt-5.5", transportModel:"gpt-5.5", assertedModel:"gpt-5.5", verdict:parseVerdict(prose + "\n" + verdictBlock({version:1, reviewedHead:stale ? "c".repeat(40) : head, slot:"Codex", assertedModel:"gpt-5.5", modelSource:"codex-launch", verdict:"PASS", findings:[]})) }));
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

it.each(["topic", "ship", "dogfood", "review", "land"])("M-stale-workflow: %s carries trusted receipt and keeps assertion separate", name => {
  const text = readSkillText(join(root, `.agentrig/skills/${name}/SKILL.md`));
  expect(text).toContain("transport-proven pinned model");
  expect(text).toContain("--provenance <PREFIX>.provenance.json");
  expect(text).toContain("Preserve assertedModel");
  expect(text).toContain("API configured model echoes are not transport attestation");
  expect(text).not.toContain("Substitute the slot name, asserted model");
  expect(text).not.toContain("adapter's asserted-model");
  expect(text).not.toContain("compares each asserted model against that slot's pin");
});
it("M-land-drop-receipt: execute land validation with actual adapter receipt", () => {
  const land = readSkillText(join(root, ".agentrig/skills/land/SKILL.md"));
  const command = land.match(/`(node <REPO>\/scripts\/review-finding-index\.mjs --validate [^`]+)`/)![1]!;
  const dir = mkdtempSync(join(tmpdir(), "land-receipt-"));
  try {
    const verdict = {version:1, reviewedHead:head, assertedModel:"gpt-5", modelSource:"identity", slot:"Codex", verdict:"PASS", findings:[]};
    const file = join(dir, "body.md"), receipt = join(dir, "receipt.json");
    writeFileSync(file, verdictBlock(verdict));
    writeFileSync(receipt, JSON.stringify({exit:0, reviewedHead:head, slot:"Codex", model:"gpt-5.5", transportModel:"gpt-5.5", assertedModel:"gpt-5", verdict, adapter:"codex-cli"}));
    const script = command.replaceAll("<REPO>", root).replace("FILE", file).replace("REVIEWED_HEAD", head).replace("SLOT", "Codex").replace("MODEL", "gpt-5.5").replace("TRUSTED_ADAPTER_RECEIPT", receipt);
    const run = spawnSync("/bin/sh", ["-ec", script], {encoding:"utf8"});
    expect(run.status, run.stderr).toBe(0);
    rmSync(receipt);
    expect(spawnSync("/bin/sh", ["-ec", script]).status).not.toBe(0);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
