import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
const source = readFileSync(new URL("../../../scripts/review-verdict.mjs", import.meta.url), "utf8")
  .replace("new URL('../packages/core/package.json', import.meta.url)", `new URL(${JSON.stringify(new URL("../../core/package.json", import.meta.url).href)})`);
const head = "a".repeat(40);
const value = {version:1, reviewedHead:head, slot:"slot", assertedModel:"pin", modelSource:"fixture", verdict:"PASS", findings:[]};
const mutants = [
  {name:"M-stale-binding", from:"verdict[key] !== expected[key]", to:"false", value:{...value, reviewedHead:"b".repeat(40)}, expected:{reviewedHead:head}},
  {name:"M-full-literal-head", from:"z.string().regex(/^[0-9a-f]{40}$/, 'reviewedHead must be a full literal commit SHA')", to:"z.string()", value:{...value, reviewedHead:`${head}~1..${head}`}, expected:{}},
  {name:"M-pass-blocker", from:"v.verdict === 'PASS' && v.findings.some(f => f.blocking)", to:"false", value:{...value, findings:[{severity:"HIGH", heading:"Anything", location:"a.ts:1", blocking:true, scenario:"Drops evidence"}]}, expected:{}},
];
it.each(mutants)("$name is killed by the schema rejection probe", async mutant => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-mutant-"));
  try {
    expect(source).toContain(mutant.from);
    for (const changed of [false,true]) {
      const file = join(dir, changed ? "mutant.mjs" : "baseline.mjs");
      writeFileSync(file, changed ? source.replace(mutant.from, mutant.to) : source);
      const schema = await import(/* @vite-ignore */ pathToFileURL(file).href);
      const probe = () => expect(() => schema.parseVerdict(schema.verdictBlock(mutant.value), mutant.expected)).toThrow();
      if (changed) expect(probe).toThrow(); else probe();
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
