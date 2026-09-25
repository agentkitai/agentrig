import { readSkillText } from "../../../test/skill-text.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readSkillText(new URL(`../../../${path}`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => text.split(start)[1]?.split(end)[0] ?? "";
const requirements = [
  { path: ".agentrig/skills/topic/SKILL.md", start: "   - **Independent conductor checks", end: "   - **Launch each slot", phrases: ["BEFORE reviewers", "PR HEAD", "ordered named steps", "Require GREEN BEFORE launching any reviewer", "Empty steps", "name, command, exit code", "UTC start/end, counts", "Restore tracked/index state", "recheck current PR head before launch", "Supply receipts to every slot"] },
  { path: "docs/SHIPPING-WORKFLOW.md", start: "## 3.", end: "## 4.", phrases: ["GREEN BEFORE launching any reviewer", "reviewers do NOT run checks", "Hosted CI overlaps review", "exact current head", "Missing independent proof", "Empty steps", "One slot is also the focused-delta reviewer"] },
  { path: ".agentrig/skills/land/SKILL.md", start: "## 1.", end: "## 2.", phrases: ["GREEN BEFORE launching any reviewer", "reviewers do NOT run checks", "shipping policy §3", "exact-head hosted CI", "Missing/failed proof blocks landing", "explicit none receipt"] },
  { path: ".agentrig/skills/ship/SKILL.md", start: "## 2.", end: "## 3.", phrases: ["independent conductor tree", "GREEN BEFORE launching any reviewer", "topic §2 step 4", "Reviewers judge code only", "reviewers do NOT run checks", "empty steps run no commands"] },
];

for (const { path, start, end, phrases } of requirements) {
  const check = (text: string) => {
    const operative = section(text, start, end).replace(/\s+/g, " ");
    for (const phrase of phrases) expect(operative).toContain(phrase);
  };
  it(`${path} pins initial trio execution, acceptance or delegation at its operative section`, () => check(read(path)));
  it.each(phrases)(`${path} rejects removal of %s even with an out-of-section copy`, phrase => {
    const text = read(path);
    check(text);
    const operative = section(text, start, end);
    const expression = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g");
    const changed = operative.replace(expression, "REMOVED");
    expect(changed).not.toBe(operative);
    expect(() => check(text.replace(operative, changed) + `\n${operative}`)).toThrow();
  });
}

it("topic gates posting on check receipts for every slot", () => {
  const posting = section(read(".agentrig/skills/topic/SKILL.md"), "# Slot posting gate\n", "```");
  const guard = '[ -s "<OUT>/checks.md" ] || exit 2';
  expect(posting).toContain(guard);
  expect(posting.indexOf(guard)).toBeLessThan(posting.indexOf("node <REPO>/scripts/post-review-comment.mjs"));
});

const completeness = "For acceptance or rerun detection, an initial review is present as a complete unnumbered single-comment review with the complete canonical heading, or when every numbered chunk (k/N), k=1..N, exists on the PR with the same complete canonical heading and consistent N; a heading alone or a partial set is missing review evidence. A nonzero helper exit may leave partial comments: preserve the OUT/*.receipt.json receipt, reconcile and remove all comments from that attempt before removing its receipt and retrying; never certify a partial review as complete.";
it.each(["topic", "ship", "land", "dogfood"])("R379 %s requires all chunks and kills completeness deletion", skill => {
  const end = skill === "land" ? "## 0." : "## Review scratch cleanup";
  const check = (text: string) => expect(section(text, "## Initial full review heading contract", end).replace(/\s+/g, " ")).toContain(completeness.replace(/\s+/g, " "));
  const text = read(`.agentrig/skills/${skill}/SKILL.md`);
  check(text);
  // R391-wrapping: formatting cannot change completeness semantics.
  check(text.replace(completeness, completeness.replace(/ /g, "\n  ")));
  expect(() => check(text.replace(completeness, ""))).toThrow();
  // R379-out-of-section-copy: an appendix cannot satisfy the operative gate.
  expect(() => check(text.replace(completeness, "") + `\n${completeness}`)).toThrow();
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
it.each(["valid", "stale", "overlong", "heading", "missing-checks", "missing-provenance", "helper-failure"])("executes actual topic posting gate and helper: %s", mode => {
  const dir = mkdtempSync(join(tmpdir(), "slot-gate-"));
  try {
    const head = "a".repeat(40), main = "b".repeat(40), prefix = join(dir, "slot");
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const gate = section(read(".agentrig/skills/topic/SKILL.md"), "# Extract with the slot's configured adapter id (including api:<name>).\n", "```");
    expect(gate).toContain("'<PREFIX>.validated.json'");
    expect(gate.trim()).toMatch(/\|\| exit 2$/);
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho posted >> '${dir}/posted'\n${mode === "helper-failure" ? "exit 1" : "echo https://example.test/comment"}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewers: { Custom: { adapter: "api:peer", model: "pin" } } }));
    writeFileSync(`${prefix}.model.txt`, "pin");
    const body = mode === "stale" ? `Reviewed head: ${head}\nReviewed at ${main}` : mode === "overlong" ? `Reviewed head: ${head}a\nVERDICT: PASS` : mode === "heading" ? "## title\n" : `Reviewed head: ${head}\nVERDICT: PASS\n`;
    const block = mode === "heading" ? body : `${body}\n<!-- agentrig-verdict:v1 -->\n${JSON.stringify({version:1, reviewedHead:mode === "stale" ? main : mode === "overlong" ? head + "a" : head, slot:"Custom", assertedModel:"pin", modelSource:"fixture", verdict:"PASS", findings:[]})}\n<!-- /agentrig-verdict -->`;
    writeFileSync(`${prefix}.md`, block);
    if (mode !== "missing-checks") writeFileSync(join(dir, "checks.md"), "green checks");
    if (mode !== "missing-provenance") writeFileSync(`${prefix}.provenance.json`, JSON.stringify({ exit:0, reviewedHead:head, slot:"Custom", adapter:"api:peer", home:null, model:"pin", transportModel:"pin", assertedModel:"pin", verdict:{version:1, reviewedHead:head, assertedModel:"pin", modelSource:"fixture", slot:"Custom", verdict:"PASS", findings:[]} }));
    const command = gate.replaceAll("<ADAPTER>", "api:peer").replaceAll("<REPO>", repo).replaceAll("<OUT>", dir).replaceAll("<PREFIX>", prefix).replaceAll("<WT>/.agentrig/config.json", join(dir, "config.json")).replaceAll("'<SLOT>'", "'Custom'").replaceAll("'HEAD'", `'${head}'`).replaceAll("<MODEL>", "pin").replaceAll('"HEAD"', `"${head}"`).replaceAll('"MAIN"', `"${main}"`).replace(".mjs NN ", ".mjs 414 ");
    const run = spawnSync("/bin/sh", ["-c", `${command}\nprintf gate-complete`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(run.status, run.stderr).toBe(mode === "valid" ? 0 : 2);
    expect(run.stdout.includes("gate-complete")).toBe(mode === "valid");
    expect(existsSync(join(dir, "posted"))).toBe(mode === "valid" || mode === "helper-failure");
    if (mode === "valid") expect(readFileSync(`${prefix}.comment.md`, "utf8")).toContain(body.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
