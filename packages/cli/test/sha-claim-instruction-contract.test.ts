import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const source = readFileSync(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url), "utf8").split("# Slot posting gate\n")[1]!.split("\n")[0]!.match(/node -e '([^']+)'/)![1]!;
const head = "a".repeat(40), stale = "c".repeat(40);
const first = `Reviewed head: ${head}\n`;
function run(body: string, program = source) {
  const dir = mkdtempSync(join(tmpdir(), "sha-claim-"));
  try {
    const input = join(dir, "review"); writeFileSync(input, body);
    return spawnSync(process.execPath, ["-e", program, input, head], { env: { ...process.env, GIT_TRACE2_EVENT: "0" } }).status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const slot of ["Claude Code", "Codex"]) {
  it.each(["Reviewed head <SHA>", "Reviewed head prose", "head HEAD", "head OLD", "head NEW", 'Quoted "Reviewed head <SHA>" and "Reviewed head prose"', `head ${"a".repeat(41)}`, `head ${stale}z`, "reviewed abcdef", "headSHAdeadbeef", "head SHAdeadbeef", "revieweddeadbeef", `inline \`Reviewed head ${stale}\``, `\`\`Reviewed head ${stale} and \`nested\` \`\``, `\`\`\`text\nReviewed head ${stale}\n\`\`\``, `~~~text\nReviewed head ${stale}\n~~~`])(`${slot} ignores nonclaims/code: %s`, text => {
    expect(run(first + text + "\nVERDICT: PASS")).toBe(0);
  });
  it.each(["head_sha:", "Reviewed at", "Previously reviewed commit", "Reviewed head:"])(`${slot} rejects stale hex: %s`, label => {
    expect(run(first + `${label} ${stale}\nverdict`)).toBe(2);
    expect(run(first + `${label} ${head.slice(0, 7)}\nverdict`)).toBe(0);
  });
  it.each(["", "Reviewed head: HEAD\n", "Reviewed head: <SHA>\n", `Reviewed head: ${stale}\n`, `\`Reviewed head: ${head}\`\n`, "verdict\n"])(`${slot} requires matching first line: %s`, prefix => expect(run(prefix + first + "verdict")).toBe(prefix === "" ? 0 : 2));
  it(`${slot} kills hex-requirement removal`, () => {
    const mutant = source.replaceAll("([0-9a-f]{7,40})", "([A-Za-z<>]+|[0-9a-f]{7,40})");
    expect(mutant).not.toBe(source);
    expect(run(first + "Reviewed head prose", mutant)).toBe(2);
  });
  it(`${slot} kills code-span skip removal`, () => {
    const mutant = source.replace("const claimText=unquoted", "const claimText=s");
    expect(mutant).not.toBe(source);
    expect(run(first + `inline \`Reviewed head ${stale}\``, mutant)).toBe(2);
  });
  it(`${slot} stale hex outside code still fails`, () => expect(run(first + `\`head ${head}\` head ${stale}`)).toBe(2));
}

it("requires a review-owned first line even when later prose names current head", () => expect(run(`VERDICT: PASS\nhead ${head}`)).toBe(2));
it("accepts abbreviated uppercase first-line SHA", () => expect(run(`Reviewed head: ${head.slice(0, 7).toUpperCase()}\nPASS`)).toBe(0));

it.each(["", `Reviewed head: ${head}\n`])("preserves heading-only rejection: %s", extra => expect(run(first + extra)).toBe(2));

// Inspect the shared prompt instruction before adapter dispatch, not the later validator.
const topic = readFileSync(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url), "utf8");
const firstLineInstruction = "Start your review with the exact own first line Reviewed head: <actual review SHA>, replacing <actual review SHA> with the full 40-hex SHA you actually reviewed. No heading, blank line, quote or code fence may precede or wrap that line.";
function checkPromptPropagation(text: string) {
  const launch = text.split("**Launch each slot through its adapter**")[1]!.split("```sh")[0]!;
  const prompt = launch.split("The prompt says:")[1]!;
  expect(prompt.replace(/\s+/g, " ")).toContain(firstLineInstruction);
  expect(launch).toContain("Write a fresh prompt file");
  expect(text).toContain("'<SLOT>' <OUT>/prompt.txt <WT> <PREFIX>");
}
it("propagates the own-first-line contract into every slot's dispatched prompt", () => {
  checkPromptPropagation(topic);
  expect(run(first + "VERDICT: PASS")).toBe(0);
});
it("kills deletion of the prompt requirement even while the posting gate retains it", () => {
  checkPromptPropagation(topic);
  const mutant = topic.replace(firstLineInstruction, "Report the exact head SHA you reviewed");
  expect(mutant).not.toBe(topic);
  expect(() => checkPromptPropagation(mutant)).toThrow();
});
