// Deterministic E1 reference traces through real CLI config + builder, with current recommended defaults.
// Same task bodies as task-baseline.mjs. Fake model usage is synthetic; no model capability claim.
import { mkdtemp, readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { buildProgram } from '../../packages/cli/dist/program.js';
import { buildAgent } from '../../packages/cli/dist/agent-builder.js';
import { supervise } from '../../packages/supervisor/dist/index.js';
import { prepare } from '../../eval/workspace.mjs';
import { tasks } from '../../eval/tasks.mjs';
import { check } from '../../eval/check.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'r17-e1-')));
const git = (cwd, args) => execFileSync('git', args, {cwd,encoding:'utf8'});
git(root,['clone','--quiet','--branch','fixture',join(root,'eval/fixtures/is-number-pinned.bundle'),join(temp,'source')]);
const results=[];
for (const [id, task] of Object.entries(tasks)) {
 const prep=await prepare(id,id.startsWith('A')?root:join(temp,'source'),join(temp,id));
 const cwd=prep.workspace, writes={};
 if(id.startsWith('A')) execFileSync('pnpm',['install','--offline','--ignore-scripts'],{cwd,stdio:'pipe'});
 if (task.seed) {
  const [path,before,after]=task.seed;
  writes[path]=(await readFile(join(cwd,path),'utf8')).replace(after,before);
 }
 if (id==='A1') writes['packages/memory/test/eval-alias.test.ts']=`import {it,expect} from 'vitest'; import {serializePage,parsePage} from '@agentkitai/agentrig-memory'; it('quoted aliases round trip',()=>{ const fm={type:'entity' as const,slug:'a',aliases:['last, first',' say "hi" ','a\\\\b'],sources:['doc:a'],updated:'2026-09-05',confidence:'high' as const}; expect(parsePage(serializePage(fm,'')).frontmatter).toEqual(fm); });\n`;
 if (id==='A2') writes['packages/memory/test/eval-retrieve.test.ts']=`import {it,expect} from 'vitest'; import {unionRetrieve} from '@agentkitai/agentrig-memory'; it('index-only match survives',()=>{const page={path:'entities/a.md',frontmatter:{type:'entity' as const,slug:'a',aliases:[],sources:['doc:a'],updated:'2026-09-05',confidence:'high' as const},body:'other',updatedAt:0}; expect(unionRetrieve([{slug:'a',path:page.path,type:'entity',status:'active',summary:'nebula'}],[page],'nebula',1).map(h=>h.via)).toEqual(['index']);});\n`;
 if (id==='A3') {
  const path='packages/memory/src/page.ts', source=await readFile(join(cwd,path),'utf8');
  const body=source.match(/export function wikilinks\(body: string\): string\[\] \{[\s\S]*?\n\}/)[0];
  writes['packages/memory/src/wikilinks.ts']=body+'\n'; writes[path]=source.replace(body,'export { wikilinks } from "./wikilinks.js";');
  writes['packages/memory/test/eval-links.test.ts']=`import {it,expect} from 'vitest'; import {wikilinks} from '@agentkitai/agentrig-memory'; it('preserves ordered unique trimmed links',()=>expect(wikilinks('[[b]] [[ a ]] [[b]] [[ ]]')).toEqual(['b','a']));\n`;
 }
 if (id==='A4') {
  const evidence=[];
  for (const [path,needle] of [['packages/core/src/events.ts','auxiliary.usage'],['packages/cli/src/render.ts','auxiliary.usage']]) evidence.push({path,quote:(await readFile(join(cwd,path),'utf8')).split('\n').find(s=>s.includes(needle)).trim()});
  writes['answer.json']=JSON.stringify({eventType:'auxiliary.usage',snapshots:'replace-by-id',finalEvent:'session.end',missingUsage:'unknown',mainIncludesAuxiliary:false,evidence});
  writes['answer.md']='Auxiliary snapshots replace earlier values by id; they are not added together. Main usage excludes auxiliary calls. A snapshot lacking a final report remains unfinished with unknown usage, not a free zero-token call. session.end carries the terminal accounting.\n';
 }
 if (id==='X2') writes['strict.js']="'use strict'; module.exports = value => typeof value === 'number' && Number.isFinite(value);\n";
 if (id==='X3') writes['classify.js']="'use strict'; const number = require('./'); module.exports = value => typeof value === 'number' && Number.isFinite(value) ? 'number' : typeof value === 'string' && number(value) ? 'numeric-string' : 'other';\n";
 if (id.startsWith('X')&&id!=='X4') {
  const module=id==='X1'?'index':id==='X2'?'strict':'classify';
  const expected=id==='X1'?"typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))":id==='X2'?"typeof value === 'number' && Number.isFinite(value)":"typeof value === 'number' && Number.isFinite(value) ? 'number' : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? 'numeric-string' : 'other'";
  writes['eval-test-reference.js']=`const assert=require('assert'); const fn=require('./${module}'); for(const value of [0,-2,NaN,Infinity,'',' ',' 2 ','0xff','1e3',true,null,[],new Number(2),Symbol('s'),2n]) assert.strictEqual(fn(value),${expected});\n`;
 }
 if (id==='X4') {
  const quote=(await readFile(join(cwd,'index.js'),'utf8')).split('\n').find(s=>s.includes("num.trim()" )).trim();
  writes['answer.json']=JSON.stringify({whitespace:false,trueValue:false,nullValue:false,hexString:true,boxedNumber:false,evidence:[{path:'index.js',quote}]});
  writes['answer.md']='The archive is stale and conflicts with the current predicate. Whitespace-only strings, booleans, null and boxed numbers are rejected. Hexadecimal numeric strings remain accepted. No production or test files were changed.\n';
 }
 const reads=[...new Set(task.seed?[task.seed[0]]:id==='A3'?['packages/memory/src/page.ts']:id==='A4'?['packages/core/src/events.ts','packages/cli/src/render.ts']:['index.js'])];
 const calls=[...reads.map(path=>({name:'read_file',input:{path}})),...Object.entries(writes).map(([path,content])=>({name:'write_file',input:{path,content}}))];
 let index=0, asks=0, ingestCalls=0, ingestReport;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body); const memory=!request.tools;
  let delta;
  if(memory){ingestCalls++;delta={content:JSON.stringify({facts:[],nothingDurable:true})};}
  else {const call=calls[index++];delta=call?{tool_calls:[{index:0,id:String(index),type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{content:'Reference changes complete.'};}
  res.setHeader('content-type','text/event-stream');
  for(const payload of [{choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:2}}])res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const home=join(temp,'home',id);await mkdir(home,{recursive:true});
 process.env.OPENAI_API_KEY='local-fixture-only';
 let opts;
 await buildProgram({config:{cwd,home,env:{}},run:async(_task,value)=>{opts=value;}}).parseAsync(['node','agentrig','run',task.prompt,'--provider','openai','--model','gpt-4o','--base-url',`http://127.0.0.1:${server.address().port}`,'--memory',join(temp,'memory',id),'--root',join(temp,'sessions',id),'--no-repo-map']);
 if(!opts)throw new Error('config resolution failed');
 const built=await buildAgent(opts,{onAsk:async()=>{asks++;return 'allow';},onIngestUsage:(report,final)=>{if(final)ingestReport=report;}});
 const session=built.agent.run(task.prompt,{cwd});
 const observer=opts.supervise?supervise(session):undefined;
 const events=[];for await(const event of session.events)events.push(event);await session.done;
 observer?.detach();await observer?.done;
 await built.closeTelemetry?.();await new Promise(r=>server.close(r));
 const checked=await check(prep.receiptPath);
 const row={task:id,permissionPrompts:asks,turnsToDone:events.filter(e=>e.type==='turn.start').length,sessionEnd:events.at(-1)?.type,reason:events.at(-1)?.reason,sessionId:session.id,ingestCalls,ingestReport,implicitDiagnosticCheckers:opts.diagnostics,checkpointCount:events.filter(e=>e.type==='checkpoint.created').length,toolErrors:events.filter(e=>e.type==='tool.result'&&e.ok===false),check:checked};
 results.push(row); console.log(JSON.stringify(row));
}
await writeFile(join(root,'docs/plans/R17b-repair-e1.json'),JSON.stringify(results.map(({check,...row})=>({...row,check:{outcome:check.outcome,behavior:check.behavior}})),null,2)+'\n');
await writeFile(join(temp,'results.json'),JSON.stringify(results,null,2)); console.log('ARTIFACTS '+temp);
if(results.some(r=>r.toolErrors.length>0||r.ingestReport?.outcome!=='completed'||r.ingestCalls<1||r.reason!=='done'||!['PASS','BLOCKED'].includes(r.check.outcome)||r.check.behavior!=='PASS')) process.exitCode=1;
