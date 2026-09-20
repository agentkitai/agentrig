import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => `.agentrig/skills/${name}/SKILL.md`;
const checks: Array<[string, string, string, string[]]> = [
 ["M-lander-fixer-receipt",skill("land"),"## 1.",["quote `Repair round: N/3`", "ledger blocker IDs", "`gh pr view NN --json body` read-back receipt BEFORE", "Reject a missing quote", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "match that line against the round, OLD and assigned blockers", "counter repaired by the fixer afterwards cannot retroactively satisfy it"]],
 ["M-claim-documentation",skill("topic"),"## 2.",["Reject 41-or-more hex tokens", "stale `head_sha:`", "stale `Reviewed at`", "fails closed on a prior `reviewed commit <stale>` discussion mention"]],
 ["M-mechanical-closure", "docs/SHIPPING-WORKFLOW.md", "## 3.",["it cannot replace independent focused review to close a blocker"]],
 ...["topic", "ship", "land"].map(name => ["M-model-heading", skill(name), "## Initial full review heading contract", ["initial heading model must equal `claude-opus-5`", "missing required initial review, not a receipt"]] as [string,string,string,string[]]),
 ["M-topic-pin",skill("topic"),"## 2.",["claude -p --model claude-opus-5"]],
 ["M-ship-pin",skill("ship"),"## 2.",["`--model claude-opus-5` verbatim", "`claude -p --model claude-opus-5`"]],
 ...[skill("topic"),"docs/SHIPPING-WORKFLOW.md"].map(path => ["M-delta-closure",path,"## 3.", ['git rev-parse --verify "$OLD^{commit}"','git rev-parse --verify "$NEW^{commit}"','[ "$OLD" != "$NEW" ]','git merge-base --is-ancestor "$OLD" "$NEW"',"fixer delta plus independent focused review","ledger rebuttal quoting a reproducible command and its result","arbiter verdict","prohibit re-prompting the raising reviewer under the","conductor’s contract reading as closure"]] as [string,string,string,string[]]),
 ...["topic","ship"].map(name => ["M-fixer-readback",skill(name),"## 3.",["Read back `gh pr view NN --json body` BEFORE spawning", "Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim", "Dispatch only ledger-blocking findings", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "Require edit success and read back the receipt", "Record any reclassification in the ledger first with its rationale", "Nonblocking defects go to residual issues; advisory"]] as [string,string,string,string[]]),
 ...["ship", "topic"].map(name => ["M-land-persistence",skill(name),"Before invoking land",["`gh pr view NN --json body`","Fetch linked review comments too","verify both initial canonical headings", "dispositions for every", "`## Residuals` has issue links or", "explicit `none`", "halt BEFORE land-child spawning", "including the pinned Claude model", "reviewed head and main provenance", "every focused review", "Verify all blocker closures and delta coverage through current head", "Persist edits then read back again if anything changes"]] as [string,string,string,string[]]),
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
 const anchor = "Before invoking land";
 const start = section.indexOf(anchor);
 expect(start).toBeGreaterThanOrEqual(0);
 expect(section.slice(start - 2, start)).toBe("\n\n");
 const spawn = section.indexOf(name === "ship" ? "- When scoped merge authorization" : "Then spawn a land subagent");
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
  const gate = s.match(/Before invoking land[\s\S]*?Persist edits then read back again if anything changes\./)![0];
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
 const end = id === "M-fixer-readback" ? "Only then call the fixer described below, carrying that persisted ledger and counter." : "a receipt added after dispatch cannot retroactively authorize that dispatch.";
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
it("C4 removes redundant length guards from both topic validators", () => {
 expect(read(skill("topic"))).not.toContain("c.length>40 ||");
});
for(const reviewer of ["Claude", "Codex"]) {
 const source=()=>read(skill("topic")).split(`# ${reviewer} posting gate\n`)[1]!.split("\n")[0]!;
 const run=(body:string, mutant=false)=>{
  const dir=mkdtempSync(join(tmpdir(),"claim-gate-"));
  try { const input=join(dir,"input"); writeFileSync(input,body);
   let program=source().match(/node -e '([^']+)'/)![1]!;
   if(mutant) {
    if(body.startsWith("head ")) program=program.replace('[0-9a-f]{7,}', '[0-9a-f]{7,40}');
    else if(body.startsWith("head_sha:")) program=program.replace('headsha|','');
    else program=program.replace('|at','');
   }
   return spawnSync(process.execPath,["-e",program,input,"a".repeat(40)],{env:{...process.env,GIT_TRACE2_EVENT:"0"}}).status;
  } finally {rmSync(dir,{recursive:true,force:true});}
 };
 for(const [id,claim] of [["M-41hex",`head ${"a".repeat(41)}`],["M-head-sha",`head_sha: ${"c".repeat(40)}`],["M-reviewed-at",`Reviewed at ${"c".repeat(40)}`]]) {
  it(`${reviewer} ${id} rejects`,()=>expect(run(`${claim}\nverdict`)).toBe(2));
  it(`${reviewer} ${id} grammar-reversion mutant`,()=>expect(run(`${claim}\nverdict`,true)).toBe(0));
 }
 it(`${reviewer} prior-reviewed-commit discussion fails closed`,()=>expect(run(`Reviewed head ${"a".repeat(40)}\nPreviously reviewed commit ${"c".repeat(40)} had a defect.\nverdict`)).toBe(2));
 it(`${reviewer} current supported claims pass`,()=>expect(run(`head_sha: ${"a".repeat(40)}\nReviewed at ${"a".repeat(7)}\nverdict`)).toBe(0));
}

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
