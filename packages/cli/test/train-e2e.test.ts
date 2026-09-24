import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cliEnv } from "./cli-env.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
it("built train CLI runs a real child, captures usage, finishes one row and halts on exact-merge CI", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "train-built-")));
  const checkout = join(root, "checkout"), queue = join(root, "train"), home = join(root, "home"), bin = join(root, "bin");
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const marker = body.match(/agentrig-train-row:[a-f0-9-]+/u)?.[0];
    if (!marker) { response.writeHead(400).end("missing row marker"); return; }
    await writeFile(join(root, "marker"), marker);
    const pr = ++requests;
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ pr }) }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no fixture listener");
  try {
    for (const dir of [join(checkout, ".git"), join(queue, "queue"), join(home, ".agentrig"), bin]) await mkdir(dir, { recursive: true });
    await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [checkout]: true } }));
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ provider: "openai", model: "fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, ingestOnEnd: false, toolSummaries: false, repoMap: false, skillDiscovery: false, extensionDiscovery: false }));
    // Only external executables are fakes. Both train and its child use the built CLI.
    const script = `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2); const root = ${JSON.stringify(root)}; const name = require('node:path').basename(process.argv[1]); const sha = 'a'.repeat(40), merge = 'b'.repeat(40); fs.appendFileSync(root+'/calls', JSON.stringify([name,...a])+'\\n');
if(name==='pnpm') process.exit(0);
if(name==='git') {
 if(a[0]==='rev-parse') console.log(a[1]==='--show-toplevel' ? ${JSON.stringify(checkout)} : sha);
 if(a[0]==='branch') console.log('main');
 if(a[0]==='remote') console.log('https://github.com/owner/repo.git');
 if(a[0]==='merge-base' && a.at(-1)===sha) process.exit(1);
} else if(name==='gh') {
 if(a[0]==='pr') { fs.writeFileSync(root+'/pr',a[2]); console.log(JSON.stringify({number:Number(a[2]),state:'MERGED',baseRefName:'main',headRefOid:sha,mergeCommit:{oid:merge},body:fs.readFileSync(root+'/marker','utf8')})); }
 if(a[0]==='run') console.log(JSON.stringify([{workflowName:'CI',event:'push',headBranch:'main',headSha:merge,status:'completed',conclusion:fs.readFileSync(root+'/pr','utf8')==='1'?'success':'failure'}]));
}`;
    for (const name of ["git", "gh", "pnpm"]) await writeFile(join(bin, name), script, { mode: 0o755 });
    for (const id of ["001", "002", "003"]) await writeFile(join(queue, "queue", `${id}.json`), JSON.stringify({ task: `Fixture ${id}`, authorization: "Fixture only", scope: ["src"], environment: { checkout, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } }));
    const env = { ...cliEnv(), PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home, OPENAI_API_KEY: "fixture" };
    const output = await exec(process.execPath, [cli, "train", queue], { env, cwd: checkout, timeout: 25_000 }).catch((error: { code: number; stdout: string; stderr: string }) => { expect(error.code).toBe(1); return error; });
    expect(JSON.parse(output.stdout.trim().split("\n").at(-1)!)).toEqual({ type: "train.end", reason: "halted" });
    expect(requests).toBe(2);
    expect(await readdir(join(queue, "done"))).toEqual(["001.json"]);
    expect(await readdir(join(queue, "halted"))).toEqual(["002.json"]);
    expect(await readdir(join(queue, "queue"))).toEqual(["003.json"]);
    expect(JSON.parse(await readFile(join(queue, "logs/001.result.json"), "utf8"))).toEqual({ pr: 1 });
    expect(JSON.parse(await readFile(join(queue, "logs/002.halt.json"), "utf8"))).toMatchObject({ phase: "ci", reason: expect.stringContaining("post-merge CI not green on exact merge commit") });
    const status = await exec(process.execPath, [cli, "train", queue, "--status"], { env });
    expect(status.stdout).toContain('"done"');
    const usage = await exec(process.execPath, [cli, "usage", "--train-dir", queue, "--row", "001", "--json"], { env });
    expect(JSON.parse(usage.stdout)).toMatchObject({ row: "001", totals: { input: 10, output: 2 } });
    const calls = await readFile(join(root, "calls"), "utf8");
    expect(calls.match(/\["pnpm","build"\]/gu)).toHaveLength(2);
    expect(calls).toContain('["gh","run","list","--repo","owner/repo","--commit","' + "b".repeat(40));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
