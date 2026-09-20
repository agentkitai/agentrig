import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => `.agentrig/skills/${name}/SKILL.md`;
const checks: Array<[string, string, string, string[]]> = [
 ["M-lander-fixer-receipt",skill("land"),"For every dispatched fixer",["quote `Repair round: N/3`", "ledger blocker IDs", "`gh pr view NN --json body` read-back receipt BEFORE", "Reject a missing quote", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "match that line against the round, OLD and assigned blockers", "counter repaired by the fixer afterwards cannot retroactively satisfy it"]],
 ["M-claim-documentation",skill("topic"),"Bounded claim grammar",["Reject 41-or-more hex tokens", "stale `head_sha:`", "stale `Reviewed at`", "fails closed on a prior `reviewed commit <stale>` discussion mention"]],
 ["M-mechanical-closure", "docs/SHIPPING-WORKFLOW.md", "## 3.",["it cannot replace independent focused review to close a blocker"]],
 ...["topic", "ship", "land"].map(name => ["M-model-heading", skill(name), "## Initial full review heading contract", ["initial heading model must equal `claude-opus-5`", "missing required initial review, not a receipt"]] as [string,string,string,string[]]),
 ["M-topic-pin",skill("topic"),"4. Run the",["claude -p --model claude-opus-5"]],
 ["M-ship-pin",skill("ship"),"## 2.",["`--model claude-opus-5` verbatim", "`claude -p --model claude-opus-5`"]],
 ...[skill("topic"),"docs/SHIPPING-WORKFLOW.md"].map(path => ["M-delta-closure",path,"## 3.", ['git rev-parse --verify "$OLD^{commit}"','git rev-parse --verify "$NEW^{commit}"','[ "$OLD" != "$NEW" ]','git merge-base --is-ancestor "$OLD" "$NEW"',"fixer delta plus independent focused review","ledger rebuttal quoting a reproducible command and its result","arbiter verdict","prohibit re-prompting the raising reviewer under the","conductor’s contract reading as closure"]] as [string,string,string,string[]]),
 ...["topic","ship"].map(name => ["M-fixer-readback",skill(name),"Before calling a fixer",["Read back `gh pr view NN --json body` BEFORE spawning", "Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim", "Dispatch only ledger-blocking findings", "Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>", "in the GitHub PR body BEFORE dispatch", "Require edit success and read back the receipt", "Record any reclassification in the ledger first with its rationale", "Nonblocking defects go to residual issues; advisory"]] as [string,string,string,string[]]),
 ["M-land-persistence",skill("ship"),"Before invoking land",["`gh pr view NN --json body`","Fetch linked review comments too","verify both initial canonical headings", "dispositions for every", "`## Residuals` has issue links or", "explicit `none`", "halt BEFORE land-child spawning"]],
];
for (const [id,path,start,phrases] of checks) {
 const check = (s: string) => { expect(s).toContain(start); const part=s.slice(s.indexOf(start)).replace(/\s+/g," "); for(const phrase of phrases) expect(part).toContain(phrase); };
 it(`${id} ${path}`,()=>check(read(path)));
 for (const phrase of phrases) it(`${id} deletion mutant: ${path} ${phrase}`,()=>{
  const s=read(path); check(s); const flat=s.replace(/\s+/g," "); expect(()=>check(flat.replaceAll(phrase,"REMOVED"))).toThrow();
 });
}
for(const reviewer of ["Claude", "Codex"]) {
 const source=()=>read(skill("topic")).split(`# ${reviewer} posting gate\n`)[1]!.split("\n")[0]!;
 const run=(body:string, mutant=false)=>{
  const dir=mkdtempSync(join(tmpdir(),"claim-gate-"));
  try { const input=join(dir,"input"); writeFileSync(input,body);
   let program=source().match(/node -e '([^']+)'/)![1]!;
   if(mutant) program=program.replace('c.length>40 ||','').replace('[0-9a-f]{7,}', '[0-9a-f]{7,40}').replace('headsha|','').replace('|at','');
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
