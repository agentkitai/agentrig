import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readSkillText } from "../../../test/skill-text.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const head = "a".repeat(40), main = "b".repeat(40);
const skills = ["topic", "ship"];
it("#411 restores network-free and macOS fixture guidance", () => {
  const text = readSkillText(join(root, ".agentrig/skills/dogfood/SKILL.md"));
  for (const phrase of ["network-free", "ModelProvider", "fetchFn", "realpath", "macOS", "tmpdir"]) expect(text).toContain(phrase);
});
describe.each(skills)("%s actual posting shell", skill => {
  const text = readSkillText(join(root, `.agentrig/skills/${skill}/SKILL.md`));
  const topic = readSkillText(join(root, ".agentrig/skills/topic/SKILL.md"));
  const start = topic.indexOf("node <REPO>/scripts/review-finding-index.mjs --extract");
  const end = topic.indexOf("     ```", start);
  const template = topic.slice(start, end);
  it("uses current extraction helper, never inline lastIndexOf extraction", () => {
    expect(start).toBeGreaterThan(0);
    expect(template).toContain("--extract '<ADAPTER>'");
    expect(template).not.toContain("lastIndexOf");
    if (skill === "ship") expect(text).toContain("shared extraction and slot posting gate");
    expect(text).toContain("REVIEW_LARGE_BODY_LEDGER");
    expect(text).toContain("40 KiB");
  });
  it.each(["pass", "echo", "stale", "markerless-stale", "codex-tail", "codex-blank-lf", "codex-blank-crlf", "claude-json", "quote"])("executes real helpers: %s", mode => {
    expect(start, "posting block must use shared helper").toBeGreaterThan(0);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "verdict-gates-")));
    try {
      mkdirSync(join(dir, ".agentrig"));
      writeFileSync(join(dir, ".agentrig/config.json"), JSON.stringify({ reviewers: {
        Codex: { adapter: "codex-cli", model: "gpt-5.5" },
        "Claude Code": { adapter: "claude-cli", model: "claude-opus-5" },
      } }));
      let body = `Reviewed head: ${mode.includes("stale") ? "c".repeat(40) : head}\nVERDICT: PASS\n`;
      if (mode === "echo") body += "A pass verdict lists what you probed and which mutants you ran\n";
      if (mode === "markerless-stale") body += "Full review comments:\n### HIGH: Regression\nGate is broken.\n";
      if (mode === "codex-tail") body = `OpenAI Codex\nuser\nInstructions\ncodex\n${body}codex\nTail evidence.\n`;
      if (mode.startsWith("codex-blank-")) {
        const eol = mode === "codex-blank-crlf" ? "\r\n" : "\n";
        body = `OpenAI Codex\nuser\nInstructions\ncodex\n\n \t\n${body}codex\nTail evidence.\n`.replaceAll("\n", eol);
      }
      if (mode === "quote") body += "### LOW: Contract mismatch\nscripts/post-review-comment.mjs:30 fix the gate. Contract says:\n> A pass verdict lists what you probed and which mutants you ran\n";
      writeFileSync(join(dir, "codex.md"), body);
      const claude = `Reviewed head: ${head}\nVERDICT: PASS\nProbed the gate.\n`;
      writeFileSync(join(dir, "claude.md"), mode === "claude-json" ? JSON.stringify({type:"result",subtype:"success",modelUsage:{"claude-opus-5":{}},result:claude,is_error:false}) : claude);
      writeFileSync(join(dir, "codex.model.txt"), "gpt-5.5");
      writeFileSync(join(dir, "claude.model.txt"), "claude-opus-5");
      writeFileSync(join(dir, "checks.md"), "Named proof receipts.\n");
      writeFileSync(join(dir, "gh"), '#!/bin/sh\nprintf "called\\n" >> "$OUT/gh.log"\nprintf "https://github.com/agentkitai/agentrig/pull/1#issuecomment-1\\n"\n', {mode:0o755});
      for (const name of ["codex", "claude"]) writeFileSync(join(dir, `${name}.provenance.json`), "{}");
      const script = [["codex", "Codex", "codex-cli"], ["claude", "Claude Code", "claude-cli"]].map(([prefix, slot, adapter]) => template.replaceAll("<REPO>", root).replaceAll("<WT>", dir).replaceAll("<OUT>", dir).replaceAll("<PREFIX>", join(dir, prefix!)).replaceAll("<SLOT>", slot!).replaceAll("<ADAPTER>", adapter!).replaceAll('"HEAD"', JSON.stringify(head)).replaceAll('"MAIN"', JSON.stringify(main)).replace(".mjs NN ", ".mjs 1 ")).join("\n");
      const result = spawnSync("/bin/sh", ["-ec", script], {cwd:dir,encoding:"utf8",env:{...process.env,PATH:`${dir}:${process.env.PATH}`,OUT:dir,HEAD:head,MAIN:main,PR:"1"}});
      if (["echo", "stale", "markerless-stale"].includes(mode)) {
        expect(result.status).not.toBe(0);
        expect(() => readFileSync(join(dir, "gh.log"))).toThrow();
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n")).toHaveLength(2);
        if (mode === "codex-tail") expect(readFileSync(join(dir, "codex.comment.md"), "utf8")).toContain("codex\nTail evidence.");
        if (mode.startsWith("codex-blank-")) {
          const extracted = readFileSync(join(dir, "codex.verdict.md"), "utf8");
          expect(extracted.split(/\r?\n/)[0]).toBe(`Reviewed head: ${head}`);
          expect(readFileSync(join(dir, "codex.comment.md"), "utf8")).toMatch(/codex\r?\nTail evidence/);
        }
      }
    } finally { rmSync(dir, {recursive:true,force:true}); }
  });
});
