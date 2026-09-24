import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const head = "a".repeat(40);
const authorization = "I authorize merging this named task after its reviews and CI.";
const row = "agentrig-train-row:17b1b85d-5d2f-4e35-aafc-3c5272028099";
const prompt = `Row: ${JSON.stringify({ authorization })}\nInclude this exact host-generated row binding on its own line in the PR body: ${row}`;
const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
const role = { name: "lander", origin: "project:lander", hash: "b".repeat(64), tools: ["bash"], modelRole: "subagents", provider: "selected", delegable: false };
const envelope = { task: "Follow land for PR #7", parent: "parent", role };

async function fixture(mode = "ok", initial = prompt) {
  const root = await mkdtemp(join(tmpdir(), "merge-guard-")); roots.push(root);
  const bin = join(root, "gh");
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'), a=process.argv.slice(2), root=${JSON.stringify(root)};
const mode=fs.readFileSync(root+'/mode','utf8');
fs.appendFileSync(root+'/calls',JSON.stringify(a)+'\\n');
if(mode==='timeout') {setTimeout(()=>{},10000);return;}
if(mode==='failure') {console.error('API unavailable');process.exit(1);}
const head='a'.repeat(40), row=${JSON.stringify(row)}, authorization=${JSON.stringify(authorization)};
const pr={number:7,url:'https://github.com/agentkitai/agentrig/pull/7',state:'OPEN',headRefName:'feature',headRefOid:head,body:row+'\\n'+(mode==='missing-auth'?'':mode==='edited-auth'?authorization+'x':authorization)};
if(mode==='edited-auth') pr.body=row+'\\n'+authorization.replace('authorize','authorized');
if(mode==='missing-row') pr.body=authorization;
if(mode==='wrong-pr') pr.url='https://github.com/other/repo/pull/7';
if(mode==='moved-head') pr.headRefOid='b'.repeat(40);
if(a[0]==='rev-parse') console.log('feature');
else if(a[0]==='pr'&&a[1]==='list') console.log(JSON.stringify([pr]));
else if(a[0]==='pr'&&a[1]==='view') console.log(JSON.stringify(pr));
else if(a[0]==='pr'&&a[1]==='checks') console.log(JSON.stringify(mode==='empty-ci'?[]:[{name:'ship',bucket:mode==='red'?'fail':mode==='pending'?'pending':'pass',state:mode==='red'?'FAILURE':mode==='pending'?'PENDING':'SUCCESS'}]));
else if(a.includes('POST')) { let input=''; process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(root+'/record',JSON.parse(input).body);console.log(JSON.stringify({id:123}));}); }
else if(a[1]?.includes('/comments/123')) console.log(JSON.stringify({id:123,body:mode==='tampered-record'?'edited':fs.readFileSync(root+'/record','utf8')}));
else if(a[1]?.includes('/check-runs')) console.log(JSON.stringify({total_count:mode==='truncated'?101:1,check_runs:[{name:'ship',head_sha:mode==='stale-ci'?'b'.repeat(40):head,status:'completed',conclusion:mode==='skipped'?'skipped':'success'}]}));
else if(a[1]?.includes('/status')) console.log(JSON.stringify({sha:head,total_count:0,statuses:[]}));
else {console.error('unexpected '+JSON.stringify(a));process.exit(2);}
`, { mode: 0o755 });
  await writeFile(join(root, "mode"), "ok");
  const mod = await import(/* @vite-ignore */ pathToFileURL(resolve("packs/ship/extensions/dispatch-record.mjs")).href);
  const hooks = new Map<string, (context: any) => Promise<any>>();
  mod.activate({ hooks: { on(point: string, handler: any) { hooks.set(point, handler); } } }, { gh: bin, git: bin, budgetMs: mode === "timeout" ? 2000 : 25_000 });
  const invoke = (point: string, fields: object) => hooks.get(point)!({ point, cwd: root, sessionId: "parent", ...fields });
  await invoke("user_prompt", { prompt: initial });
  const dispatch = async (spawn: any = envelope) => {
    const pre = await invoke("pre_spawn", { sessionId: "spoof", spawn, tool: { name: "subagent", input: { task: "not authority", agent: "builder" } } });
    if (pre.action === "continue") await invoke("post_spawn", { spawn: { ...spawn, childId: "child" } });
    return pre;
  };
  const merge = async (text = command, sessionId = "child") => {
    await writeFile(join(root, "mode"), mode);
    return invoke("pre_tool", { sessionId, tool: { name: "bash", input: { command: text } } });
  };
  return { root, invoke, dispatch, merge };
}

describe("minimal merge guard", () => {
  it("allows authorized green dispatched lander via gh and REST without review evidence", async () => {
    const f = await fixture(); expect((await f.dispatch()).action).toBe("continue");
    expect(await f.merge()).toEqual({ action: "continue" });
    expect(await f.merge(`gh api repos/agentkitai/agentrig/pulls/7/merge -X PUT -f sha=${head} -f merge_method=squash`)).toEqual({ action: "continue" });
    expect(await f.merge(`gh api repos/agentkitai/agentrig/pulls/7/merge -XPUT -fsha=${head}`)).toEqual({ action: "continue" });
  });
  it.each(["missing-auth", "edited-auth", "missing-row", "wrong-pr", "moved-head", "empty-ci", "red", "pending", "stale-ci", "skipped", "truncated", "tampered-record", "failure", "timeout"])("denies %s with a reason", async mode => {
    const f = await fixture(mode); expect((await f.dispatch()).action).toBe("continue");
    const result = await f.merge(); expect(result.action).toBe("deny"); expect(result.reason).toMatch(/^merge guard: .+/u);
  });
  it.each(["parent", "unrecorded-child"])("refuses %s even with green CI and authorization", async id => {
    const f = await fixture(); await f.dispatch(); expect((await f.merge(command, id)).reason).toContain("lander child");
  });
  it("requires successful dispatch AND post-spawn child record", async () => {
    const f = await fixture();
    await f.invoke("pre_spawn", { spawn: envelope });
    expect((await f.merge()).action).toBe("deny");
  });
  it("does not accept forged post-spawn or tool-input lander role", async () => {
    const f = await fixture();
    await f.invoke("post_spawn", { spawn: { ...envelope, childId: "child" } });
    expect((await f.merge()).action).toBe("deny");
    await f.dispatch({ ...envelope, role: { ...role, name: "builder" } });
    expect((await f.merge()).action).toBe("deny");
  });
  it("matches exact task, parent, role, provider and tools across spawn phases", async () => {
    for (const change of [{ task: "edited" }, { parent: "other" }, { role: { ...role, provider: "other" } }, { role: { ...role, tools: ["edit_file"] } }]) {
      const f = await fixture(); await f.invoke("pre_spawn", { spawn: envelope });
      await f.invoke("post_spawn", { spawn: { ...envelope, ...change, childId: "child" } });
      expect((await f.merge()).action).toBe("deny");
    }
  });
  it("only initial Row.authorization grants authority; session/task text cannot replace it", async () => {
    const f = await fixture("ok", `No Row. ${authorization}`);
    await f.invoke("user_prompt", { prompt });
    expect((await f.dispatch()).action).toBe("deny");
    expect((await f.merge()).action).toBe("deny");
    const g = await fixture();
    await g.invoke("user_prompt", { prompt: prompt.replace(authorization, "edited authority") });
    expect((await g.dispatch()).action).toBe("continue"); expect((await g.merge()).action).toBe("continue");
  });
  it.each([
    `gh pr merge 7 --squash`, `gh api repos/agentkitai/agentrig/pulls/7/merge -XPUT`,
    `gh pr merge 7 --auto=true --match-head-commit ${head}`, `gh pr merge 7 --auto --match-head-commit ${head}`,
    `echo ignored; ${command}`, `gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId }}'`,
    `curl -X PUT https://api.github.com/repos/agentkitai/agentrig/pulls/7/merge`,
    `gh api repos/agentkitai/agentrig/pulls/7/merge -X PUT --input request.json`,
    `gh pr merge 7 --match-head-commit ${"b".repeat(40)}`,
  ])("refuses unverifiable merge %s", async text => {
    const f = await fixture(); await f.dispatch(); expect((await f.merge(text)).action).toBe("deny");
  });
  it("leaves reads alone and preserves ledger-integrity body-edit refusal", async () => {
    const f = await fixture();
    expect(await f.merge("gh pr view 7")).toEqual({ action: "continue" });
    expect(await f.merge("gh api repos/agentkitai/agentrig/pulls/7/merge", "parent")).toEqual({ action: "continue" });
    expect(await f.merge("gh api repos/agentkitai/agentrig/pulls/7/merge -X GET", "parent")).toEqual({ action: "continue" });
    expect((await f.merge("gh pr edit 7 --body replaced")).reason).toContain("append-only");
    expect(await readFile(join(f.root, "calls"), "utf8")).toContain('"pr","view"');
  });
});
