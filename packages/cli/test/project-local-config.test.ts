import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { loadRunConfig } from '../src/config.js';
import { resolveProjectChecks } from '../src/project-checks.js';
import { projectConfigPath, readProjectConfig } from '../src/project-config.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(),'local-config-'))); roots.push(root);
 const project = join(root,'foreign'), home = join(root,'home');
 await mkdir(join(project,'.git'),{recursive:true}); await mkdir(home);
 const path = await projectConfigPath(project,home); await mkdir(join(path,'..'),{recursive:true});
 return {project,home,path};
}
it('resolves per-repository checks without a committed .agentrig and isolates other roots',async () => {
 const {project,home,path}=await fixture();
 await writeFile(path,JSON.stringify({packs:{ship:{checks:{bootstrap:'true',steps:[{name:'unit',command:'python -m pytest'}]},reviewers:{}}}}));
 expect((await resolveProjectChecks(project,undefined,undefined,{home}))?.steps[0]?.command).toBe('python -m pytest');
 expect((await readProjectConfig(project,{home}))?.source).toBe(path);
 const other=join(home,'other'); await mkdir(other);
 expect(await readProjectConfig(other,{home})).toBeUndefined();
});
it('preserves project precedence and refuses malformed local declarations',async () => {
 const {project,home,path}=await fixture(); await writeFile(path,'{"unknown":true}');
 await expect(readProjectConfig(project,{home})).rejects.toThrow('Unrecognized');
 await mkdir(join(project,'.agentrig')); await writeFile(join(project,'.agentrig','config.json'),'{}');
 expect((await readProjectConfig(project,{home}))?.source).toBe(join(project,'.agentrig','config.json'));
});
it('does not activate local config for an untrusted project or unsafe home',async () => {
 const {project,home,path}=await fixture(); await writeFile(path,JSON.stringify({skills:['/portable/skills'],agentRoleRoots:['/portable/agents']}));
 const cmd=new Command('run');
 const untrusted=await loadRunConfig(cmd,{}, {cwd:project,home,env:{}});
 expect(untrusted.skills).not.toContain('/portable/skills'); expect(untrusted.agentRoleRoots).toBeUndefined();
 const trusted=await loadRunConfig(cmd,{trust:true},{cwd:project,home,env:{}});
 expect(trusted.skills).toContain('/portable/skills'); expect(trusted.agentRoleRoots).toEqual(['/portable/agents']);
 await expect(projectConfigPath(project,project)).rejects.toThrow('outside');
});

it('shares the declaration with linked worktrees',async () => {
 const {project,home,path}=await fixture();
 execFileSync('git',['init','-b','main'],{cwd:project});
 execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture'],{cwd:project});
 const wt=join(home,'worktree'); execFileSync('git',['worktree','add','-b','fixture',wt],{cwd:project});
 await writeFile(path,'{}');
 const innerHome=join(project,"inner-home"); await mkdir(innerHome);
 await expect(projectConfigPath(wt,innerHome)).rejects.toThrow("outside");
 vi.stubEnv("GIT_DIR", "/not/the/repository");
 expect(await projectConfigPath(wt,home)).toBe(path);
 expect((await readProjectConfig(wt,{home}))?.source).toBe(path);
});
it('rejects invalid role roots and malformed linked worktree metadata',async()=>{
 const {project,home,path}=await fixture();
 await writeFile(path,'{"agentRoleRoots":["relative"]}');
 await expect(readProjectConfig(project,{home})).rejects.toThrow('absolute');
 await rm(join(project,'.git'),{recursive:true}); await writeFile(join(project,'.git'),'not git');
 await expect(projectConfigPath(project,home)).rejects.toThrow();
});

it('validates bounded plain CI workflow metadata', async()=>{
 const {project,home,path}=await fixture();
 for(const ciWorkflows of [[],[""],["\n"],["x".repeat(201)],Array(51).fill("CI"),["CI\u001b"]]) {
   await writeFile(path,JSON.stringify({packs:{ship:{ciWorkflows}}}));
   await expect(readProjectConfig(project,{home})).rejects.toThrow("invalid config");
 }
 await writeFile(path,'{ "packs": { "ship": { "ciWorkflows": ["Foreign CI"] } } }\r\n');
 expect((await readProjectConfig(project,{home}))?.config.packs?.ship).toEqual({ciWorkflows:["Foreign CI"]});
});
