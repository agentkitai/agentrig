import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function probe(code: string) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8", timeout: 15_000 });
}

describe("E3 frozen live-comparison mechanics (no live calls)", () => {
  it("balances all 96 attempts with three repeats and each condition equally at every position", () => {
    probe(`import assert from 'node:assert/strict'; import {schedule} from './eval/live-support.mjs';
      const runs=schedule(); assert.equal(runs.length,96); assert.equal(new Set(runs.map(r=>JSON.stringify([r.task,r.repeat,r.supervisor,r.memory]))).size,96);
      for(const s of [false,true])for(const m of [false,true])for(let p=0;p<4;p++) assert.equal(runs.filter(r=>r.supervisor===s&&r.memory===m&&r.position===p).length,6);`);
  });
  it("refuses unknown usage, exhausted total tokens and expired experiment time", () => {
    probe(`import assert from 'node:assert/strict'; import {guard,TOTAL_TOKENS} from './eval/live-support.mjs';
      guard({tokens:0,startedAt:Date.now()});
      for(const ledger of [{tokens:TOTAL_TOKENS,startedAt:Date.now()},{tokens:0,startedAt:0},{tokens:0,startedAt:Date.now(),blocked:'quota'},{tokens:0,startedAt:Date.now(),unknownCalls:3}])assert.throws(()=>guard(ledger),/BLOCKED/);
      guard({tokens:0,startedAt:Date.now(),unknownCalls:1});`);
  });
  it("hashes corpus contents and paths reproducibly and detects mutation", () => {
    probe(`import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,cp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {digestTree} from './eval/live-support.mjs';
      const root=await mkdtemp(join(tmpdir(),'agentrig-e3-hash-'));
      try{const a=join(root,'a'),b=join(root,'b');await mkdir(a);await writeFile(join(a,'page.md'),'training only');
        await cp(a,b,{recursive:true});const initial=await digestTree(a);assert.equal(initial,await digestTree(b));
        await writeFile(join(b,'page.md'),'held-out contamination');assert.notEqual(initial,await digestTree(b));
      }finally{await rm(root,{recursive:true,force:true})}`);
  });
  it("keeps pending and unrun slots visible and reports variability without a benefit claim", () => {
    probe(`import assert from 'node:assert/strict';import {summarize,spread} from './eval/summarize-live.mjs';
      assert.deepEqual(spread([9,1,3,5]),{n:4,min:1,median:4,max:9});assert.equal(spread([]),null);
      const s=summarize({ledger:{blocked:'quota'},completed:[{supervisor:false,memory:false,outcome:'BLOCKED',reportedTokens:3,wallMs:9}]});
      assert.equal(s.planned,96);assert.equal(s.completed,1);assert.equal(s.groups[0].outcomes.BLOCKED,1);assert.equal(s.groups[0].notRun,23);
      assert.equal(s.groups[1].notRun,24);assert.match(s.conclusion,/No benefit claim/);`);
  });
  it("pins worker identity and exposes only its workspace with no network or inherited credentials", () => {
    probe(`import assert from 'node:assert/strict'; import {dockerArgs} from './eval/live-support.mjs';
      const options={name:'agentrig-e3-abcd',image:'sha256:'+'a'.repeat(64),workspace:process.cwd()};
      const args=dockerArgs(options);assert.equal(args[args.indexOf('--network')+1],'none');
      assert(args.includes('--cap-drop=ALL'));assert(args.includes('--read-only'));assert(args.includes('--security-opt=no-new-privileges'));
      assert.equal(args.filter(x=>x==='--mount').length,1);assert(!args.some(x=>/docker.sock|API_KEY|CHATGPT_TOKEN|evaluator/.test(x)));
      assert.throws(()=>dockerArgs({...options,image:'node:22'}));assert.throws(()=>dockerArgs({...options,name:'user-container'}));
      assert.throws(()=>dockerArgs({...options,workspace:'/tmp/a,dst=/'}));`);
  });
  it("counts disjoint cumulative final usage once and fixes Luna/subscription/no retries", () => {
    probe(`import assert from 'node:assert/strict';import {metered} from './eval/live.mjs';
      const ledger={tokens:0,startedAt:Date.now()},calls=[];
      const provider=metered(null,ledger,calls,'main',options=>{
        assert.equal(options.model,'gpt-5.6-luna');assert.equal(options.reasoningEffort,'medium');assert.equal(options.retry.maxRetries,0);
        return {id:'openai-chatgpt',model:options.model,capabilities:{},async *stream(){
          yield {type:'usage',usage:{input:1,output:1}};yield {type:'usage',usage:{input:2,output:3,cacheRead:4,cacheWrite:5}};yield {type:'stop',reason:'end_turn'};}}});
      for await(const e of provider.stream({},new AbortController().signal)){};
      assert.equal(ledger.tokens,14);assert.equal(calls.length,1);assert.equal(calls[0].complete,true);assert.equal(ledger.blocked,undefined);`);
  });
  it("does not invent zero usage for absent, synthetic, unclosed, errored or cancelled requests", () => {
    probe(`import assert from 'node:assert/strict';import {metered} from './eval/live.mjs';
      for(const kind of ['absent','synthetic','unclosed','error','throw']){
        const ledger={tokens:0,startedAt:Date.now()},calls=[];
        const p=metered(null,ledger,calls,'supervisor',()=>({id:'stub',model:'stub',capabilities:{},async *stream(){
          if(kind==='throw')throw new Error('cancelled');
          if(kind!=='absent')yield {type:'usage',reported:kind!=='synthetic',usage:{input:0,output:0}};
          if(kind!=='unclosed')yield {type:'stop',reason:kind==='error'?'error':'end_turn'};}}));
        try{for await(const e of p.stream({},new AbortController().signal)){}}catch{}
        assert.equal(calls[0].complete,false);assert.equal(ledger.unknownCalls,1);
      }`);
  });
  it("continues after a bounded expected cancellation but stops on subscription quota errors", () => {
    probe(`import assert from 'node:assert/strict';import {metered} from './eval/live.mjs';import {guard} from './eval/live-support.mjs';
      for(const expected of [true,false]){const ledger={tokens:0,startedAt:Date.now()};
        const p=metered(null,ledger,[],'supervisor',()=>({capabilities:{},async *stream(){throw expected?new DOMException('cancelled','AbortError'):new Error('HTTP 429 usage limit');}}));
        try{for await(const e of p.stream({},new AbortController().signal)){}}catch{}
        assert.equal(ledger.unknownCalls,1);if(expected)guard(ledger);else assert.throws(()=>guard(ledger),/provider failure/);
      }`);
  });
  it("blocks new provider calls without invoking the underlying provider after a guard trips", () => {
    expect(probe(`import assert from 'node:assert/strict';import {metered} from './eval/live.mjs';
      const p=metered(null,{tokens:1e7,startedAt:Date.now()},[],'main',()=>({capabilities:{},async *stream(){throw Error('must not run')}}));
      await assert.rejects(async()=>{for await(const e of p.stream({},new AbortController().signal)){}},/total reported-token/);console.log('ok');`)).toContain("ok");
  });
  it("runs all four real SDK configurations with scripted responses and no live calls", () => {
    probe(`import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
      import {runSession} from './eval/live.mjs';import {FileMemoryStore} from './packages/memory/dist/index.js';
      const root=await mkdtemp(join(tmpdir(),'agentrig-e3-scripted-'));
      try{const corpus=join(root,'corpus');const wiki=new FileMemoryStore({root:corpus});await wiki.init();
        await wiki.upsertIndex({slug:'training',path:'concepts/training.md',type:'concept',status:'active',summary:'FROZEN_TRAINING_SENTINEL'});
        for(const supervisor of [false,true])for(const memory of [false,true]){
          const dir=join(root,randomUUID());await mkdir(dir);const calls=[];
          const factory=()=>({id:'openai-chatgpt',model:'gpt-5.6-luna',capabilities:{tools:true,parallelTools:true,caching:false,contextWindow:100000},async *stream(req){
            calls.push(req);yield {type:'text_delta',text:'scripted only'};yield {type:'usage',usage:{input:2,output:1}};yield {type:'stop',reason:'end_turn'};}});
          const result=await runSession({worker:'unused'}, {workspace:dir,runId:randomUUID(),id:'X1'}, {supervisor,memory},dir,corpus,{tokens:0,startedAt:Date.now()},null,undefined,factory);
          assert.equal(result.calls.length,1);assert.equal(result.calls[0].complete,true);assert.equal(result.complete,true);
          assert.equal(calls[0].tools.some(t=>t.name==='memory_search'),memory);assert.equal(calls[0].tools.some(t=>t.name==='memory_read'),memory);
          assert.equal(calls[0].system.includes('FROZEN_TRAINING_SENTINEL'),memory);
          if(memory){assert.equal(await readFile(join(dir,'wiki/index.md'),'utf8'),await readFile(join(corpus,'index.md'),'utf8'));}
          assert(!calls[0].tools.some(t=>t.name==='memory_write'));
          assert.equal(result.events.at(-1).type,'session.end');assert(result.settledAt>=result.events.at(-1).ts);
          assert.equal(JSON.parse(await readFile(join(dir,'session.json'),'utf8')).summary.reason,'done');
        }
      }finally{await rm(root,{recursive:true,force:true})}`);
  });
});
