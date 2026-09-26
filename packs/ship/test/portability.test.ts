import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgram } from "../../../packages/cli/src/program.js";
import { discoverSkills, discoverAgentRoleDirectory, loadExtensions } from "@agentkitai/agentrig-core";
import { loadRunConfig } from "../../../packages/cli/src/config.js";
import { resolveProjectChecks } from "../../../packages/cli/src/project-checks.js";
import { shipTrainStages } from "../src/train.js";
// The activation entry is a supported built-source executable, not a test-only loader.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
it("activates ship outside a real foreign git repository and exercises skills, script, hooks, lander and declared train checks", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"ship-portable-"))); roots.push(root);
 const project=join(root,"foreign"), home=join(root,"home"), bin=join(root,"bin");
 await mkdir(project); await mkdir(home); await mkdir(bin);
 execFileSync("git",["init","-b","main"],{cwd:project,env:{...process.env,GIT_TRACE2_EVENT:"0"}});
 execFileSync("git",["remote","add","origin","https://github.com/fixture/foreign.git"],{cwd:project});
 execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture"],{cwd:project});
 const declaration=join(root,"declaration.json");
 await writeFile(declaration,JSON.stringify({packs:{ship:{checks:{bootstrap:"printf bootstrap",preflight:"printf preflight",steps:[{name:"unit",command:"printf foreign"}]},reviewers:{},ciWorkflows:["Foreign CI"]}}}));
 const launch=()=>spawnSync(process.execPath,[resolve("packs/ship/activate.mjs"),project,declaration],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home},encoding:"utf8"});
 const original=await readFile(declaration,"utf8");
 for (const [text,message] of [["{}","requires declared"],[JSON.stringify({unknown:true}),"Unrecognized"],[" ".repeat(1_048_577),"exceeds 1 MiB"]]) {
   await writeFile(declaration,text); const failed=launch(); expect(failed.status).not.toBe(0); expect(failed.stderr).toContain(message);
 }
 await writeFile(declaration,original);
 const activated=JSON.parse(execFileSync(process.execPath,[resolve("packs/ship/activate.mjs"),project,declaration],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home},encoding:"utf8"}));
 expect(launch().stderr).toContain("activation already exists");
 const poster=spawnSync(process.execPath,[resolve("packs/ship/scripts/post-review-comment.mjs"),"1","undeclared","model","body","a".repeat(40),"b".repeat(40),"output"],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home},encoding:"utf8"});
 expect(poster.status).toBe(2); expect(poster.stderr).toContain("undeclared reviewer slot");
 await expect(access(join(project,".agentrig"))).rejects.toThrow();
 const opts=await loadRunConfig(buildProgram().commands.find(c=>c.name()==="run")!,{trust:true},{cwd:project,home,env:{}});
 expect(opts.extension).toEqual([resolve("packs/ship/extensions/dispatch-record.mjs")]);
 expect(opts.agentRoleRoots).toEqual([resolve("packs/ship/agents")]);
 const skills=await discoverSkills({roots:opts.skills as string[]}); expect(skills.map(s=>s.name)).toEqual(["arbiter","dogfood","land","review","ship","topic"]);
 const canonical=await discoverSkills({roots:[resolve("packs/ship/skills")]});
 for(const entry of canonical) {
   expect(skills.find(s=>s.name===entry.name)?.body).toContain(entry.body);
   expect(skills.find(s=>s.name===entry.name)?.flags).toEqual(entry.flags);
 }
 expect(skills.find(s=>s.name==="ship")?.body).toContain(activated.config);
 expect(skills.find(s=>s.name==="land")?.body).toContain(resolve("packs/ship/scripts/review-verdict.mjs"));
 const roles=await discoverAgentRoleDirectory(activated.roles); expect(roles.map(r=>r.name)).toEqual(["lander"]); expect(roles[0]?.delegable).toBe(false); expect(roles[0]?.tools).not.toContain("subagent");
 const gh=join(bin,"gh"); await writeFile(gh,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(root,"gh.calls"))},process.argv.slice(2).join(' ')+'\\n'); console.log('[]');\n`,{mode:0o755});
 // Real extension loader, with executable lookup pointing at the fixture GitHub transport.
 const saved=process.env.PATH; process.env.PATH=`${bin}:${saved}`;
 try {
   const extension=await loadExtensions({candidates:[{path:opts.extension![0] as string,precedence:0}],session:{cwd:project,provider:{id:"fixture",model:"fixture"}},builtinToolNames:new Set(),reservedCommandNames:new Set(),onNotice:()=>{}});
   expect(extension.failed).toEqual([]); expect(extension.loaded).toHaveLength(1);
   const hooks=extension.loaded[0]!.hooks;
   expect(hooks.map(h=>h.point)).toContain("pre_spawn");
   const guard=hooks.find(h=>h.point==="pre_tool")!;
   const denied=await guard.handler({cwd:project,sessionId:"unbound",tool:{name:"bash",input:{command:"gh pr merge 1 --squash --match-head-commit "+"a".repeat(40)}}} as any);
   expect(denied.action).toBe("deny");
   const spawn=hooks.find(h=>h.point==="pre_spawn")!;
   const accepted=await spawn.handler({cwd:project,sessionId:"parent",spawn:{parent:"parent",task:"Build the initial scoped fixture; Repair round: 0/3"}} as any);
   expect(accepted.action).toBe("continue");
   const refused=await spawn.handler({cwd:project,sessionId:"parent",spawn:{parent:"parent",task:"Repair round: 1/3",role:roles[0]}} as any);
   expect(refused.action).toBe("deny");
   expect(await readFile(join(root,"gh.calls"),"utf8")).toContain("pr");
 } finally { process.env.PATH=saved; }
 const script=execFileSync(process.execPath,[resolve("packs/ship/scripts/review-verdict.mjs")],{cwd:project,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
 expect(typeof script).toBe("string");
 const calls:string[]=[];
 const exec=async (exe:string,argv:string[])=>{ calls.push([exe,...argv].join(" ")); if(argv[0]==="rev-parse") return argv[1]==="--show-toplevel"?project:"a".repeat(40); if(argv[0]==="branch")return "main"; if(argv[0]==="remote")return "https://github.com/fixture/foreign.git"; return ""; };
 const row={task:"fixture",scope:["src"],authorization:"fixture",environment:{checkout:project,repository:"fixture/foreign",baseBranch:"main",ciWorkflows:activated.ciWorkflows}};
 await shipTrainStages.preCheck({row,root:join(root,"train"),exec,refreshEnvironment:async()=>{},options:{projectChecks:(p,profile)=>resolveProjectChecks(p,profile,undefined,{home})}});
 expect(calls.slice(-3)).toEqual(["/bin/sh -c printf bootstrap","/bin/sh -c printf preflight","/bin/sh -c printf foreign"]);
 expect(calls.some(c=>c.startsWith("pnpm"))).toBe(false);
 calls.length=0;
 await shipTrainStages.preCheck({row,root:join(root,"train"),exec,refreshEnvironment:async()=>{},options:{projectChecks:async()=>({bootstrap:"must-not-run",steps:[]})}});
 expect(calls.some(c=>c.startsWith("/bin/sh"))).toBe(false);
 await expect(shipTrainStages.preCheck({row,root:join(root,"train"),exec,refreshEnvironment:async()=>{},options:{projectChecks:async()=>undefined}})).rejects.toThrow("missing declared");
 await expect(shipTrainStages.preCheck({row,root:join(root,"train"),exec:async (exe,args)=>{if(exe==="/bin/sh")throw Error("fixture check failed"); return exec(exe,args);},refreshEnvironment:async()=>{},options:{projectChecks:async()=>({bootstrap:"false",steps:[{name:"unit",command:"must-not-run"}]})}})).rejects.toThrow("fixture check failed");
 await expect(access(join(project,".agentrig"))).rejects.toThrow();
},30_000);
