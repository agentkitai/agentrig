import { execFile as exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionStore, undoSession, type ModelEvent } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";
import { parseConfigText } from "../src/config.ts";
import { TuiController } from "../src/tui/controller.ts";

const execFile = promisify(exec);
const cli = resolve("packages/cli/dist/index.js");
let root: string;
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),"agentrig-undo-cli-"));
  await execFile("git",["init","-q"],{cwd:root});
  await writeFile(join(root,"file.txt"),"before\r\n");
  vi.stubEnv("ANTHROPIC_API_KEY","fixture-not-live");
});
afterEach(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});

async function built() {
  const built=await buildAgent({root:join(root,"sessions"),provider:"anthropic",model:"fixture",sandbox:"none",checkpoints:true,yolo:true,repoMap:false,maxTurns:"3",maxTokensPerTurn:"1000"});
  let turn=0;
  built.provider.stream=async function*():AsyncIterable<ModelEvent>{
    if (turn++===0) {
      yield {type:"tool_use",id:"write",name:"write_file",input:{path:join(root,"file.txt"),content:"after"}};
      yield {type:"stop",reason:"tool_use"};
    } else yield {type:"stop",reason:"end_turn"};
  };
  return built;
}

it("wires opt-in builder checkpoints to the real sessions undo CLI",async()=>{
  expect(parseConfigText("fixture",JSON.stringify({checkpoints:true}))).toMatchObject({checkpoints:true});
  const b=await built(); const session=b.agent.run("write",{cwd:root}); await session.done;
  const store=new SessionStore({root:join(root,"sessions")});
  expect((await store.readAll(session.id)).some(e=>e.type==="checkpoint.sealed")).toBe(true);
  const result=await execFile(process.execPath,[cli,"sessions","undo",session.id,"--root",store.root,"--to-turn","1"],{cwd:root});
  expect(result.stdout).toContain("restored"); expect(await readFile(join(root,"file.txt"),"utf8")).toBe("before\r\n");
});

it("idle TUI undo invokes guarded core restore and starts fresh without rewriting its original log",async()=>{
  const b=await built(); const store=new SessionStore({root:join(root,"sessions")});
  const controller=new TuiController({agent:b.agent,cwd:root,onUndo:(id,toTurn)=>undoSession(store,id,{cwd:root,...(toTurn===undefined?{}:{toTurn})})});
  await controller.submit("write"); const id=controller.state.sessionId!;
  const history=await readFile(store.pathFor(id));
  await controller.submit("/undo 0"); expect(await readFile(join(root,"file.txt"),"utf8")).toBe("after");
  await controller.submit("/undo 1");
  expect(await readFile(join(root,"file.txt"),"utf8")).toBe("before\r\n");
  expect(controller.state.sessionId).toBeNull();
  expect(await readFile(store.pathFor(id))).toEqual(history);
  await controller.shutdown();
});

it("TUI refuses undo during a running session and joins an ongoing undo on shutdown",async()=>{
  const b=await built();let finish!:()=>void;const wait=new Promise<void>(r=>{finish=r;});
  b.provider.stream=async function*():AsyncIterable<ModelEvent>{await wait;yield {type:"stop",reason:"end_turn"};};
  let finishUndo!:()=>void;const undoWait=new Promise<void>(r=>{finishUndo=r;});
  const undo=vi.fn(async()=>{await undoWait;return {restored:true,message:"restored fixture"};});
  const dream=vi.fn(async()=>["dream"]);
  const controller=new TuiController({agent:b.agent,cwd:root,onUndo:undo,onDream:dream});
  const running=controller.submit("task");await controller.submit("/undo");expect(undo).not.toHaveBeenCalled();
  finish();await running;
  const undoing=controller.submit("/undo");expect(undo).toHaveBeenCalledOnce();
  await controller.submit("/dream");expect(dream).not.toHaveBeenCalled();
  let closed=false;const closing=controller.shutdown().then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);
  finishUndo();await undoing;await closing;expect(closed).toBe(true);
});
