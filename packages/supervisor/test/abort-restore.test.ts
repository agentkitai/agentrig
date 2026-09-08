import { execFile as exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Checkpointer, createAgent, RulePolicy, SessionStore, undoSession, type HarnessEvent, type ModelProvider, type Session, type SessionSummary } from "@agentkitai/agentrig-core";
import { attach, supervise, type AbortRestoreResult, type Detector } from "@agentkitai/agentrig-supervisor";

vi.setConfig({testTimeout:30_000});
const execFile=promisify(exec);
let root:string;
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),"agentrig-abort-restore-"));
  await execFile("git",["init","-q"],{cwd:root});
  await writeFile(join(root,"file.txt"),"before\r\n");
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});

const detector:Detector={id:"fixture",observe:event=>event.type==="turn.start"&&event.n===2?{type:"stall",confidence:1,evidence:["fixture"],window:[event.seq,event.seq]}:null};
const policy={decide:()=>[{type:"abort" as const,reason:"fixture"}]};

function run() {
  const store=new SessionStore({root:join(root,"sessions")});let n=0;
  const provider:ModelProvider={id:"fixture",model:"fixture",capabilities:{tools:true,parallelTools:false,caching:false,contextWindow:10000},async *stream(_request,signal){
    if(++n===1) {yield {type:"tool_use",id:"write",name:"write",input:{}};yield {type:"stop",reason:"tool_use"};}
    else {await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener("abort",()=>resolve(),{once:true});});yield {type:"stop",reason:"end_turn"};}
  }};
  const agent=createAgent({provider,store,systemPrompt:"fixture",repoMap:false,permissions:new RulePolicy([{class:"write",decision:"allow"}]),hooks:[new Checkpointer()],tools:[{name:"write",description:"write",permission:"write",inputSchema:z.object({}),execute:async()=>{await writeFile(join(root,"file.txt"),"after");return {output:null,display:"written"};}}]});
  return {store,session:agent.run("write then wait",{cwd:root})};
}

it.each([false,true])("supervisor abort restoration is opt-in (%s), uses real guarded undo, and leaves the original log closed",async enabled=>{
  const {store,session}=run();let before:Buffer|undefined;const results:AbortRestoreResult[]=[];
  const restore=vi.fn(async(id:string,signal:AbortSignal)=>{
    before=await readFile(store.pathFor(id));expect((await store.readAll(id)).at(-1)?.type).toBe("session.end");
    return undoSession(store,id,{cwd:root,signal});
  });
  const observer=attach(session,{detectors:[detector],policy,abortRestores:enabled,restoreCheckpoint:restore,onRestore:r=>results.push(r)});
  const summary=await session.done;observer.detach();await observer.done;
  expect(summary.reason).toBe("aborted");expect(restore).toHaveBeenCalledTimes(enabled?1:0);
  expect(await readFile(join(root,"file.txt"),"utf8")).toBe(enabled?"before\r\n":"after");
  if(enabled) {expect(results[0]?.restored).toBe(true);expect(await readFile(store.pathFor(session.id))).toEqual(before);}
});

it("does not restore after a user abort that this observer did not request",async()=>{
  const {session}=run();const restore=vi.fn(async()=>({restored:true,message:"unexpected"}));
  const observer=attach(session,{detectors:[],policy,abortRestores:true,restoreCheckpoint:restore});
  for await(const event of session.events) if(event.type==="turn.start"&&event.n===2)session.control.abort();
  expect((await session.done).reason).toBe("aborted");await observer.done;expect(restore).not.toHaveBeenCalled();
  expect(await readFile(join(root,"file.txt"),"utf8")).toBe("after");
});

it("preserves aborted classification when a provider closes normally after cancellation",async()=>{
  let session!:Session;
  const provider:ModelProvider={id:"fixture",model:"fixture",capabilities:{tools:false,parallelTools:false,caching:false,contextWindow:10000},async *stream(){
    session.control.abort();yield {type:"usage",usage:{input:7,output:2}};yield {type:"stop",reason:"end_turn"};
  }};
  session=createAgent({provider,store:new SessionStore({root:join(root,"sessions")}),systemPrompt:"fixture",tools:[],permissions:new RulePolicy([])}).run("cancel",{cwd:root});
  const summary=await session.done;expect(summary.reason).toBe("aborted");expect(summary.usage).toMatchObject({input:7,output:2});
});

it("supervise forwards opt-in restoration through its real budget ladder",async()=>{
  const {store,session}=run();const results:AbortRestoreResult[]=[];
  const observer=supervise(session,{capabilities:{abort:true},ladder:{ladder:["abort"]},budget:{maxTurns:2,turnsRemaining:1,soft:0.99},abortRestores:true,
    restoreCheckpoint:(id,signal)=>undoSession(store,id,{cwd:root,signal}),onRestore:result=>results.push(result)});
  expect((await session.done).reason).toBe("aborted");observer.detach();await observer.done;
  expect(results[0]?.restored).toBe(true);expect(await readFile(join(root,"file.txt"),"utf8")).toBe("before\r\n");
});

it("reports dirty-state refusal instead of replacing external edits",async()=>{
  const {store,session}=run();const errors:string[]=[];
  const observer=attach(session,{detectors:[detector],policy,abortRestores:true,restoreCheckpoint:async(id,signal)=>{
    await writeFile(join(root,"external.txt"),"human edit");return undoSession(store,id,{cwd:root,signal});
  },onError:(where,error)=>errors.push(`${where}: ${error.message}`)});
  await session.done;await observer.done;
  expect(errors.join("\n")).toContain("abort-restore: non-session changes");
  expect(await readFile(join(root,"file.txt"),"utf8")).toBe("after");
  expect(await readFile(join(root,"external.txt"),"utf8")).toBe("human edit");
});

it("never restores early and joins an already-requested restoration even after detach",async()=>{
  let settle!:(value:SessionSummary)=>void;const done=new Promise<SessionSummary>(r=>{settle=r;});
  let release!:()=>void;const restored=new Promise<void>(r=>{release=r;});
  const event:HarnessEvent={type:"turn.start",n:2,seq:0,sessionId:"s",ts:1};
  const abort=vi.fn();const record=vi.fn();
  const session={id:"s",done,events:(async function*(){yield event;})(),control:{abort,record}} as unknown as Session;
  let signal:AbortSignal|undefined;
  const restore=vi.fn(async(_id:string,s:AbortSignal)=>{signal=s;await restored;return {restored:true,message:"done"};});
  const observer=attach(session,{detectors:[detector],policy:{decide:()=>[...policy.decide(),...policy.decide()]},abortRestores:true,restoreCheckpoint:restore});
  await vi.waitFor(()=>expect(abort).toHaveBeenCalled());observer.detach();expect(restore).not.toHaveBeenCalled();
  settle({id:"s",reason:"aborted",turns:2,usage:{input:0,output:0}});
  await vi.waitFor(()=>expect(restore).toHaveBeenCalledOnce());expect(signal?.aborted).toBe(false);
  let joined=false;void observer.done.then(()=>{joined=true;});await Promise.resolve();expect(joined).toBe(false);
  release();await observer.done;expect(joined).toBe(true);
  expect(record.mock.calls.every(([e])=>e.type==="supervisor.signal" || e.type==="supervisor.intervention" || e.type==="supervisor.outcome")).toBe(true);
  // R17e: an abort is recorded as applied, and the session's own end reason remains the receipt.
  expect(record.mock.calls.some(([e])=>e.type==="supervisor.outcome" && e.intervention==="abort" && e.outcome==="applied")).toBe(true);
});

it("rejects a missing restore seam and carries the options through supervise",async()=>{
  const {session}=run();
  expect(()=>attach(session,{detectors:[],policy,abortRestores:true})).toThrow("requires a guarded");
  expect(()=>supervise(session,{abortRestores:true})).toThrow("requires a guarded");
  const restore=vi.fn(async()=>({restored:true,message:"unexpected"}));
  const observer=supervise(session,{abortRestores:false,restoreCheckpoint:restore});
  observer.detach();session.control.abort();await session.done;await observer.done;
  expect(restore).not.toHaveBeenCalled();
});

it.each(["done","budget","error"] as const)("does not restore if the abort request loses to a %s outcome",async reason=>{
  let settle!:(value:SessionSummary)=>void;const done=new Promise<SessionSummary>(resolve=>{settle=resolve;});
  const abort=vi.fn();const event:HarnessEvent={type:"turn.start",n:2,seq:0,sessionId:"s",ts:1};
  const session={id:"s",done,events:(async function*(){yield event;})(),control:{abort,record:vi.fn()}} as unknown as Session;
  const restore=vi.fn(async()=>({restored:true,message:"unexpected"}));const errors:string[]=[];
  const observer=attach(session,{detectors:[detector],policy,abortRestores:true,restoreCheckpoint:restore,onError:(_where,error)=>errors.push(error.message)});
  await vi.waitFor(()=>expect(abort).toHaveBeenCalledOnce());settle({id:"s",reason,turns:2,usage:{input:0,output:0}});
  await observer.done;expect(restore).not.toHaveBeenCalled();expect(errors[0]).toContain(`ended ${reason}, not aborted`);
});
