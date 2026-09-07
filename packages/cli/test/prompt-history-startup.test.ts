import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TuiController } from "../src/tui/controller.js";
import type { PromptHistory } from "../src/tui/prompt-history.js";
const harness = vi.hoisted(() => ({ exercise: undefined as undefined | ((controller: TuiController, history: PromptHistory, input: {send(...chunks:string[]):void}, writes:string[])=>Promise<void>), calls: [] as string[] }));
// Real Ink tree, startup/builder/controller/core/storage. Only terminal IO and provider are fixtures.
vi.mock("ink", async importOriginal => {
  const { EventEmitter } = await import("node:events");
  const original = await importOriginal<typeof import("ink")>();
  return {...original, render: (element: Parameters<typeof original.render>[0] & {props:{controller:TuiController;history:PromptHistory}}) => {
    class Input extends EventEmitter { isTTY=true; chunks:string[]=[]; setEncoding(){return this;} setRawMode(){return this;} ref(){return this;} unref(){return this;} read(){return this.chunks.shift()??null;} send(...chunks:string[]){this.chunks.push(...chunks);this.emit("readable");} }
    const input=new Input();const writes:string[]=[];
    const output=Object.assign(new EventEmitter(),{columns:90,rows:24,isTTY:true,write:(text:string)=>{writes.push(text);return true;}});
    const ink=original.render(element,{stdin:input as never,stdout:output as never,patchConsole:false,exitOnCtrlC:false});
    const done=(async()=>{await vi.waitFor(()=>expect(writes.join("")).toContain("type a task"));await harness.exercise!(element.props.controller,element.props.history,input,writes);})().finally(()=>ink.unmount());
    return {unmount:()=>ink.unmount(),waitUntilExit:()=>done};
  }};
});
vi.mock("../src/agent-builder.js",async importOriginal=>{
  const original=await importOriginal<typeof import("../src/agent-builder.js")>();
  return {...original,buildAgent:async(...args:Parameters<typeof original.buildAgent>)=>{
    const built=await original.buildAgent(...args);
    vi.spyOn(built.provider,"stream").mockImplementation(async function*(request){harness.calls.push(JSON.stringify(request.messages));yield {type:"text_delta",text:"done"};yield {type:"stop",reason:"end_turn"};});return built;
  }};
});
import { startTui } from "../src/tui/start.js";
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();harness.calls=[];for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(["", "\u001b[201~"])("real startup discovers configured skills and shows them on slash without Tab (%j)",async prefix=>{
  const root=await mkdtemp(join(tmpdir(),"agentrig-slash-start-"));roots.push(root);
  const skills=join(root,"skills");await mkdir(skills);
  await writeFile(join(skills,"zebra-startup.md"),"---\nname: zebra-startup\ndescription: fixture skill\n---\nBODY_NOT_EXECUTED");
  vi.stubEnv("ANTHROPIC_API_KEY","fixture");
  const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("no network expected"));
  const tty=Object.getOwnPropertyDescriptor(process.stdin,"isTTY");Object.defineProperty(process.stdin,"isTTY",{value:true,configurable:true});
  try {
    harness.exercise=async(c,history,input,writes)=>{
      input.send(prefix+"/");await vi.waitFor(()=>expect(writes.join("")).toContain("/zebra-startup [skill]"));
      expect(c.snapshot().sessionId).toBeNull();expect(history.values()).toEqual([]);expect(harness.calls).toEqual([]);
      input.send(prefix+"\t");await vi.waitFor(()=>expect(writes.join("")).toContain("> /zebra-startup"));
      expect(harness.calls).toEqual([]);expect(fetch).not.toHaveBeenCalled();
    };
    await startTui({root:join(root,"logs"),skills:[skills],provider:"anthropic",model:"fake",repoMap:false,maxTurns:"2",maxTokensPerTurn:"100"});
  } finally {if(tty)Object.defineProperty(process.stdin,"isTTY",tty);else Reflect.deleteProperty(process.stdin,"isTTY");}
});
it.each([true,false])("actual TUI restart recalls only trusted project disk history (trusted=%s)",async trusted=>{
  const root=await mkdtemp(join(tmpdir(),"agentrig-history-start-"));roots.push(root);vi.stubEnv("ANTHROPIC_API_KEY","fixture");
  const tty=Object.getOwnPropertyDescriptor(process.stdin,"isTTY");Object.defineProperty(process.stdin,"isTTY",{value:true,configurable:true});
  const options={root:join(root,"logs"),provider:"anthropic" as const,model:"fake",repoMap:false,maxTurns:"2",maxTokensPerTurn:"100",...(trusted?{trustedProjectRoot:root}:{})};
  try {
    harness.exercise=async(c,history,input)=>{input.send("first\\","\r","second","\r");await vi.waitFor(()=>{expect(harness.calls).toHaveLength(1);expect(c.snapshot().status).toBe("idle");},{timeout:5000});expect(history.values()).toEqual(["first\nsecond"]);};
    await startTui(options);
    harness.exercise=async(c,history,input,writes)=>{
      expect(history.values()).toEqual(trusted?["first\nsecond"]:[]);
      if(trusted){input.send("\u001b[A");await vi.waitFor(()=>expect(writes.join("")).toContain("second"));expect(harness.calls).toHaveLength(1);input.send("\r");await vi.waitFor(()=>{expect(harness.calls).toHaveLength(2);expect(c.snapshot().status).toBe("idle");},{timeout:5000});}
    };
    await startTui(options);
    if(trusted){expect(harness.calls).toHaveLength(2);expect(harness.calls[1]).toContain("first\\nsecond");expect(JSON.parse(await readFile(join(root,".agentrig/history"),"utf8")).entries).toEqual(["first\nsecond"]);}
    else await expect(readFile(join(root,".agentrig/history"))).rejects.toMatchObject({code:"ENOENT"});
  } finally {if(tty)Object.defineProperty(process.stdin,"isTTY",tty);else Reflect.deleteProperty(process.stdin,"isTTY");}
},15000);

it.each([true, false])("startTui forwards persistent verbose=%s to the mounted controller", async verbose => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-verbose-start-")); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {value:true, configurable:true});
  try {
    let observed: boolean | undefined;
    harness.exercise = async c => { observed = c.snapshot().verbose; };
    await startTui({verbose, root:join(root,"logs"), provider:"anthropic", model:"fake", maxTurns:"1", maxTokensPerTurn:"100", repoMap:false});
    expect(observed).toBe(verbose);
  } finally { if (tty) Object.defineProperty(process.stdin,"isTTY",tty); else Reflect.deleteProperty(process.stdin,"isTTY"); }
});
