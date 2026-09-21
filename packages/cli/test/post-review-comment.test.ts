import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const helper = fileURLToPath(new URL("../../../scripts/post-review-comment.mjs", import.meta.url));
const head = "a".repeat(40);
const run = (reviewers: unknown[], slot = "0", body = "PASS\n") => {
  const dir = mkdtempSync(join(tmpdir(), "review-comment-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewers }));
  writeFileSync(join(dir, "body.md"), body);
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, "gh"), 0o755);
  const result = spawnSync(process.execPath, [helper, "396", join(dir,"config.json"), slot, join(dir,"body.md"), head, join(dir,"comment.md")], { encoding:"utf8", env:{...process.env, PATH:`${dir}:${process.env.PATH}`} });
  return { dir, result };
};
it("posts arbitrary configured slot name with pinned model and canonical heading", () => {
  const {dir,result}=run([{name:"Reviewer A",adapter:"api",provider:"a",model:"model-a"}]);
  try { expect(result.status).toBe(0); expect(readFileSync(join(dir,"comment.md"),"utf8")).toBe(`## External review — Reviewer A (model-a) — head ${head} — full\n\nPASS\n`); }
  finally { rmSync(dir,{recursive:true,force:true}); }
});
it.each([[[],"0"],[Array.from({length:3},(_,i)=>({name:`R${i}`,adapter:"api",model:"m"})),"0"],[[{name:"R",adapter:"api",model:"m"}],"1"]] as const)("fails closed for undeclared/invalid slot sets", (slots,slot) => {
  const {dir,result}=run(slots as unknown[],slot); try { expect(result.status).toBe(2); } finally { rmSync(dir,{recursive:true,force:true}); }
});
it("rejects empty reviewer output before gh", () => { const {dir,result}=run([{name:"R",adapter:"api",model:"m"}],"0","\n"); try { expect(result.status).toBe(2); } finally { rmSync(dir,{recursive:true,force:true}); } });
