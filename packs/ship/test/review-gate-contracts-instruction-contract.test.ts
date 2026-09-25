import { readSkillText } from "../../../test/skill-text.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const read = (path: string) => readSkillText(new URL(`../../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => `.agentrig/skills/${name}/SKILL.md`;
const checks: Array<[string, string, string, string[]]> = [
 ["M-lander-fixer-receipt",skill("land"),"## 1.",["`gh pr view NN --json body` read-back receipt BEFORE", "Reject a missing read-back receipt", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "match that line against the round, OLD and assigned blockers", "persisted fixer task", "counter repaired by the fixer afterwards cannot retroactively satisfy it", "Review coverage, dispositions and receipt-before- dispatch ordering above remain land judgments"]],
 ["M-claim-documentation",skill("topic"),"## 2.",["delimited JSON", "No first-line head gate", "Prose quotations and range expressions", "fallback cannot satisfy a landing review"]],
 ["M-mechanical-closure", "docs/SHIPPING-WORKFLOW.md", "## 3.",["it cannot replace independent focused review to close a blocker"]],
 ...["topic", "ship", "land"].map(name => ["M-model-heading", skill(name), "## Initial full review heading contract", ["initial heading model must equal the slot's pinned model", "missing required initial review, not a receipt"]] as [string,string,string,string[]]),
 ["M-topic-pin",skill("topic"),"## 2.",["scripts/reviewer-adapters.mjs", "slot's pinned model"]],
 ["M-ship-pin",skill("ship"),"## 2.",["scripts/reviewer-adapters.mjs", "slot's pinned model"]],
 ...[skill("topic"),"docs/SHIPPING-WORKFLOW.md"].map(path => ["M-delta-closure",path,"## 3.", ['git rev-parse --verify "$OLD^{commit}"','git rev-parse --verify "$NEW^{commit}"','[ "$OLD" != "$NEW" ]','git merge-base --is-ancestor "$OLD" "$NEW"',"fixer delta plus independent focused review","ledger rebuttal quoting a reproducible command and its result","arbiter verdict","prohibit re-prompting the raising reviewer under the","conductor’s contract reading as closure"]] as [string,string,string,string[]]),
 ...["topic","ship"].map(name => ["M-fixer-readback",skill(name),"## 3.",["Read back `gh pr view NN --json body` BEFORE spawning", "Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim", "Dispatch only ledger-blocking findings", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "Require edit success and read back the receipt", "Record any reclassification in the ledger first with its rationale", "Nonblocking defects go to residual issues; advisory"]] as [string,string,string,string[]]),
 ...["ship", "topic"].map(name => ["M-land-persistence",skill(name),"Before spawning the named lander child",["`gh pr view NN --json body`","Fetch linked review comments too","verify all declared initial canonical headings", "dispositions for every", "`## Residuals` has issue links or", "explicit `none`", "halt BEFORE land-child spawning", "including each slot's pinned model", "reviewed head and main provenance", "every focused review", "Verify all blocker closures and delta coverage through current head", "Persist edits then read back again if anything changes"]] as [string,string,string,string[]]),
];
// Preserve section boundaries before normalizing whitespace for phrase comparisons.
const sectionFrom = (s: string, start: string) => {
 const i = s.indexOf(start);
 expect(i).toBeGreaterThanOrEqual(0);
 const tail = s.slice(i);
 const next = tail.search(/\n## /);
 return next < 0 ? tail : tail.slice(0, next);
};
const checkRow = (s: string, [id,path,start,phrases]: typeof checks[number]) => {
 const part=(id === "M-land-persistence" ? landWindow(s, path === skill("ship") ? "ship" : "topic") : id === "M-fixer-readback" ? fixerWindow(s, path) : sectionFrom(s,start)).replace(/\s+/g," ");
 for(const phrase of phrases) expect(part).toContain(phrase);
};
for (const row of checks) {
 const [id,path,,phrases] = row;
 const check = (s: string) => checkRow(s, row);
 it(`${id} ${path}`,()=>check(read(path)));
 for (const phrase of phrases) it(`${id} deletion mutant: ${path} ${phrase}`,()=>{
  const s=read(path); check(s);
  const pattern = new RegExp(phrase.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
  expect(()=>check(s.replace(pattern,"REMOVED"))).toThrow();
 });
}
// Pin the owning section first; a relocated prose anchor must never drag its window with it.
const fixerWindow = (s: string, path: string) => {
 const section = sectionFrom(s, "## 3.");
 const start = section.indexOf("Before calling a fixer");
 expect(start).toBeGreaterThanOrEqual(0);
 const spawn = section.indexOf(path === skill("ship") ? "- Spawn the fixer" : "- **Fix** with one subagent");
 expect(spawn).toBeGreaterThan(start);
 return section.slice(start, spawn);
};
// All persistence requirements must execute before dispatch, not merely in the same section.
const landWindow = (s: string, name: string) => {
 const section = sectionFrom(s, name === "ship" ? "## 3." : "## 4.");
 const anchor = "Before spawning the named lander child";
 const start = section.indexOf(anchor);
 expect(start).toBeGreaterThanOrEqual(0);
 expect(section.slice(start - 2, start)).toBe("\n\n");
 const spawn = section.indexOf(name === "ship" ? "- When scoped merge authorization" : "Then dispatch `subagent` with");
 expect(spawn).toBeGreaterThan(start);
 return section.slice(start, spawn);
};
const landGate = (s: string, name: string) => {
 const window = landWindow(s, name).replace(/\s+/g, " ");
 const phrases = checks.find(([id, path]) => id === "M-land-persistence" && path === skill(name))![3];
 for (const phrase of phrases) expect(window).toContain(phrase);
};
for (const name of ["ship", "topic"]) {
 it(`M-land-placement ${name} standalone gate before spawn in section`, () => landGate(read(skill(name)), name));
 for (const mutation of ["EOF", "after-spawn", "split-paragraph", "lazy-continuation"]) it(`M-land-placement ${name} ${mutation} mutant`, () => {
  const s = read(skill(name)); landGate(s, name);
  const gate = s.match(/Before spawning the named lander child[\s\S]*?Persist edits then read back again if anything changes\./)![0];
  let mutant = s.replace(gate, "");
  if (mutation === "EOF") mutant += `\n\n${gate}\n`;
  else if (mutation === "after-spawn") {
   const next = name === "ship" ? "## 4. Budget" : "## 5. Halt";
   mutant = mutant.replace(next, `${gate}\n\n${next}`);
  } else if (mutation === "split-paragraph") {
   const opening = gate.slice(0, gate.indexOf("\n"));
   const sentinel = "Persist edits then read back again if anything changes.";
   const middle = gate.slice(opening.length, gate.indexOf(sentinel)).trim();
   const next = name === "ship" ? "## 4. Budget" : "## 5. Halt";
   mutant = s.replace(gate, `${opening}\n${sentinel}`).replace(next, `${middle}\n\n${next}`);
  } else mutant = s.replace(`\n\n${gate}`, `\n${gate}`);
  expect(() => landGate(mutant, name)).toThrow();
 });
}
// Relocations preserve the requirements verbatim: presence alone must not satisfy a gate.
for (const row of checks.filter(([id]) => ["M-fixer-readback", "M-lander-fixer-receipt"].includes(id))) {
 const [id, path, , phrases] = row;
 const anchor = id === "M-fixer-readback" ? "Before calling a fixer" : "For every dispatched fixer";
 const end = id === "M-fixer-readback" ? "Carry the persisted receipt, exact finding identities and counter in the fixer task." : "a mechanical allow never resolves a blocker.";
 for (const location of id === "M-fixer-readback" ? ["EOF", "after-spawn"] : ["EOF"]) {
  it(`${id} ${path} whole gate relocated ${location}`, () => {
   const s = read(path); checkRow(s, row);
   const gate = s.slice(s.indexOf(anchor), s.indexOf(end) + end.length);
   const without = s.replace(gate, "");
   const next = path === skill("ship") ? "## 4. Budget" : "- **Cover the delta**";
   const mutant = location === "EOF" ? `${without}\n\n${gate}` : without.replace(next, `${gate}\n\n${next}`);
   expect(() => checkRow(mutant, row)).toThrow();
  });
 }
 if (id === "M-fixer-readback") for (const phrase of phrases) it(`${id} ${path} split gate moves requirement after spawn: ${phrase}`, () => {
  const s = read(path); checkRow(s, row);
  const pattern = new RegExp(phrase.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
  const next = path === skill("ship") ? "## 4. Budget" : "- **Cover the delta**";
  const mutant = s.replace(pattern, "REMOVED").replace(next, `${phrase}\n\n${next}`);
  expect(() => checkRow(mutant, row)).toThrow();
 });
}
it("M-section-boundary rejects a delta requirement moved to the next section", () => {
 const row = checks.find(([id, path]) => id === "M-delta-closure" && path === skill("topic"))!;
 const s = read(row[1]); checkRow(s, row);
 const phrase = row[3][0]!;
 const mutant = s.replace(phrase, "REMOVED").replace("## 4. Conditional land and continue", `## 4. Conditional land and continue\n\n${phrase}`);
 expect(() => checkRow(mutant, row)).toThrow();
});
// SHA posting-gate probes live in sha-claim-instruction-contract.test.ts (#424).

// Execute the actual documented shell gate, not a duplicate predicate.
for (const path of [skill("topic"), "docs/SHIPPING-WORKFLOW.md"]) {
 const gate = () => read(path).split("# Focused delta gate\n")[1]!.split(/\n *```/)[0]!;
 const probe = (form: string, mutant = false) => {
  const dir = mkdtempSync(join(tmpdir(), "delta-gate-"));
  const env = {...process.env, GIT_TRACE2_EVENT: "0"};
  const git = (...args: string[]) => {
   const r = spawnSync("git", args, {cwd: dir, env, encoding: "utf8"});
   expect(r.status, r.stderr).toBe(0); return r.stdout.trim();
  };
  try {
   git("init", "-q"); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "base");
   const base = git("rev-parse", "HEAD"); git("branch", "review-base");
   git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "next");
   const next = git("rev-parse", "HEAD");
   const pairs: Record<string, string[]> = {full: [base, base], abbreviated: [base.slice(0, 7), base], ref: ["review-base", base], forward: ["review-base", next], reverse: [next, base], invalid: ["missing-ref", next]};
   let program = gate();
   if (mutant) program = program.split("\n").filter(line => !line.includes("rev-parse --verify")).join("\n");
   return spawnSync("/bin/sh", ["-c", program], {cwd: dir, env: {...env, OLD: pairs[form]![0], NEW: pairs[form]![1]}}).status;
  } finally { rmSync(dir, {recursive: true, force: true}); }
 };
 for (const form of ["full", "abbreviated", "ref", "reverse", "invalid"]) it(`C2 ${path} rejects ${form}`, () => expect(probe(form)).not.toBe(0));
 it(`C2 ${path} permits forward delta`, () => expect(probe("forward")).toBe(0));
 for (const form of ["abbreviated", "ref"]) it(`C2 ${path} resolution-removal mutant admits ${form}`, () => expect(probe(form, true)).toBe(0));
}

for (const name of ["ship", "topic"]) it(`M-fixer-missing-dispatch ${name} renamed spawn anchor mutant`, () => {
 const row = checks.find(([id, path]) => id === "M-fixer-readback" && path === skill(name))!;
 const s = read(row[1]); checkRow(s, row);
 const anchor = name === "ship" ? "- Spawn the fixer" : "- **Fix** with one subagent";
 expect(s).toContain(anchor);
 expect(() => checkRow(s.replace(anchor, "- RENAMED dispatch anchor"), row)).toThrow();
});
