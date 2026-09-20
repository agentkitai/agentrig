import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const skill = (name: string) => `.agentrig/skills/${name}/SKILL.md`;
const checks: Array<[string, string, string, string[]]> = [
 ["M-lander-fixer-receipt",skill("land"),"For every dispatched fixer",["quote `Repair round: N/3`", "ledger blocker IDs", "`gh pr view NN --json body` read-back receipt BEFORE", "Reject a missing quote", "counter repaired by the fixer afterwards cannot retroactively satisfy it"]],
 ["M-claim-documentation",skill("topic"),"Bounded claim grammar",["Reject 41-or-more hex tokens", "stale `head_sha:`", "stale `Reviewed at`", "fails closed on a prior `reviewed commit <stale>` discussion mention"]],
 ["M-mechanical-closure", "docs/SHIPPING-WORKFLOW.md", "## 3.",["it cannot replace independent focused review to close a blocker"]],
 ...["topic", "ship", "land"].map(name => ["M-model-heading", skill(name), "## Initial full review heading contract", ["initial heading model must equal `claude-opus-5`", "missing required initial review, not a receipt"]] as [string,string,string,string[]]),
 ["M-topic-pin",skill("topic"),"4. Run the",["claude -p --model claude-opus-5"]],
 ["M-ship-pin",skill("ship"),"## 2.",["`--model claude-opus-5` verbatim", "`claude -p --model claude-opus-5`"]],
 ...[skill("topic"),"docs/SHIPPING-WORKFLOW.md"].map(path => ["M-delta-closure",path,"## 3.", ['[ "$OLD" != "$NEW" ]','git merge-base --is-ancestor "$OLD" "$NEW"',"fixer delta plus independent focused review","ledger rebuttal quoting a reproducible command and its result","arbiter verdict","prohibit re-prompting the raising reviewer under the","conductor’s contract reading as closure"]] as [string,string,string,string[]]),
 ...["topic","ship"].map(name => ["M-fixer-readback",skill(name),"Before calling a fixer",["Read back `gh pr view NN --json body` BEFORE spawning", "Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim", "Dispatch only ledger-blocking findings", "Record any reclassification in the ledger first with its rationale", "Nonblocking defects go to residual issues; advisory"]] as [string,string,string,string[]]),
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
