import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const adapter = fileURLToPath(new URL("../../../scripts/reviewer-adapter.mjs", import.meta.url));
function run(slot: object, executable: string, source: string) {
  const dir=mkdtempSync(join(tmpdir(),"review-adapter-"));
  writeFileSync(join(dir,"config.json"),JSON.stringify({reviewers:[slot]}));
  writeFileSync(join(dir,"brief.md"),"review exact head using supplied receipts");
  writeFileSync(join(dir,executable),source); chmodSync(join(dir,executable),0o755);
  const result=spawnSync(process.execPath,[adapter,join(dir,"config.json"),"0",dir,"base",join(dir,"brief.md"),join(dir,"raw.md"),join(dir,"model.txt")],{encoding:"utf8",env:{...process.env,PATH:`${dir}:${process.env.PATH}`}});
  return {dir,result};
}
it("validates JSON model field for the first CLI adapter",()=>{
  const {dir,result}=run({name:"A",adapter:"claude-cli",model:"pin-a"},"claude",'#!/bin/sh\nprintf \'%s\\n\' \'{"modelUsage":{"pin-a":{}},"result":"PASS A"}\'\n');
  try { expect(result.status).toBe(0); expect(readFileSync(join(dir,"raw.md"),"utf8")).toBe("PASS A"); expect(readFileSync(join(dir,"model.txt"),"utf8")).toBe("pin-a\n"); } finally { rmSync(dir,{recursive:true,force:true}); }
});
it("validates stderr banner for the second CLI adapter",()=>{
  const {dir,result}=run({name:"B",adapter:"codex-cli",model:"pin-b"},"codex",'#!/bin/sh\nprintf \'PASS B\\n\'\nprintf \'model: pin-b\\n\' >&2\n');
  try { expect(result.status).toBe(0); expect(readFileSync(join(dir,"raw.md"),"utf8")).toBe("PASS B\n"); } finally { rmSync(dir,{recursive:true,force:true}); }
});
it.each([
  ['#!/bin/sh\nprintf \'%s\\n\' \'{"modelUsage":{"wrong":{}},"result":"PASS"}\'\n',"JSON modelUsage"],
  ['#!/bin/sh\nprintf \'%s\\n\' \'{"modelUsage":{"pin":{}},"result":""}\'\n',"empty review"],
  ['#!/bin/sh\nexit 7\n',"adapter failed"],
])("fails closed for model mismatch, empty, and failed launch",(source,message)=>{
  const {dir,result}=run({name:"A",adapter:"claude-cli",model:"pin"},"claude",source);
  try { expect(result.status).toBe(2); expect(result.stderr).toContain(message); } finally { rmSync(dir,{recursive:true,force:true}); }
});
