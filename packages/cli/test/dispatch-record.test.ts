import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function probe(mode: string, name = "subagent", label?: string, budgetMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "dispatch-")); roots.push(root);
  await mkdir(join(root, "bin"));
  const script = `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const root=${JSON.stringify(root)};const mode=${JSON.stringify(mode)};
fs.appendFileSync(root+'/calls',JSON.stringify(a)+'\\n');
if(a[0]==='rev-parse') { console.log('feature');process.exit(0); }
if(mode==='timeout'){setTimeout(()=>{},10000);return;}
if(mode==='lookup-failure'){console.error('unavailable');process.exit(1);}
if(a[0]==='pr'){console.log(JSON.stringify(mode==='no-pr'?[]:[{number:7,headRefName:mode==='row'?'builder-branch':'feature',headRefOid:'a'.repeat(40),body:mode==='row'?'agentrig-train-row:17b1b85d-5d2f-4e35-aafc-3c5272028099':''}]));process.exit(0);}
if(a.includes('POST')){if(mode==='post-failure'){console.error('post failed');process.exit(1);}if(mode==='rate-limit'){console.error('HTTP 429\\nRetry-After: 60');process.exit(1);}let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync(root+'/body',JSON.parse(s).body);console.log(JSON.stringify({id:123}));});}
else {if(mode==='read-failure'){console.error('read failed');process.exit(1);} console.log(JSON.stringify({body:mode==='mismatch'?'wrong':fs.readFileSync(root+'/body','utf8')}));}`;
  for (const command of ["gh", "git"]) { await writeFile(join(root, "bin", command), script); await chmod(join(root, "bin", command), 0o755); }
  // Explicit executable injection avoids process-global PATH races between test workers.
  const mod = await import(/* @vite-ignore */ pathToFileURL(resolve(".agentrig/extensions/dispatch-record.mjs")).href);
  const handler = mod.createDispatchHook({ gh: join(root, "bin/gh"), git: join(root, "bin/git"), ...(mode === "row" ? { rowForSession: () => "agentrig-train-row:17b1b85d-5d2f-4e35-aafc-3c5272028099" } : {}), ...(budgetMs === undefined ? {} : { budgetMs }) });
  const task = 'Exact task\r\n```\nnon-ASCII: café 🔧\ntrailing newline\n';
  const result = await handler({ cwd: root, sessionId: "parent-123", tool: { name, input: { task, ...(label ? { label } : {}) } } });
  return { result, task, body: await readFile(join(root, "body"), "utf8").catch(() => ""), calls: await readFile(join(root, "calls"), "utf8").catch(() => "") };
}
it("no PR leaves initial builder untouched", async () => { const p = await probe("no-pr"); expect(p.result.action).toBe("continue"); expect(p.calls).not.toContain("POST"); });
it("posts exact task and reads back via API before continuing", async () => { const p = await probe("ok"); expect(p.result.action).toBe("continue"); expect(p.body).toContain(p.task); expect(p.body).toContain('parent-123'); expect(p.body).toContain('a'.repeat(40)); expect(p.body).toMatch(/dispatch time: \d{4}-/); expect(p.calls).toContain('issues/comments/123'); });
it.each(["post-failure", "mismatch", "lookup-failure", "rate-limit", "read-failure"])("denies %s", async mode => { const p = await probe(mode); expect(p.result.action).toBe("deny"); expect(p.result.reason).toContain("dispatch record"); });
it("non-subagent does not query GitHub", async () => { const p = await probe("ok", "bash"); expect(p.result.action).toBe("continue"); expect(p.calls).toBe(""); });
it("rejects lossy labels after PR exists", async () => { expect((await probe("ok", "subagent", "short label")).result.action).toBe("deny"); });

it("owns its timeout rather than letting the framework fail open", async () => { expect((await probe("timeout", "subagent", undefined, 100)).result.action).toBe("deny"); });

it("conductor on another branch resolves the exact host row binding", async () => { const p = await probe("row"); expect(p.result.action).toBe("continue"); expect(p.calls).toContain("--search"); expect(p.calls).not.toContain("--head"); expect(p.body).toContain(p.task); });
