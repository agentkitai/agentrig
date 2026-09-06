import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, RulePolicy, SessionStore, type ModelRequest, type Skill } from "@agentkitai/agentrig-core";
import { App } from "../src/tui/app.js";
import { TuiController } from "../src/tui/controller.js";
import { PromptHistory } from "../src/tui/prompt-history.js";

class Input extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding() { return this; } setRawMode() { return this; } ref() { return this; } unref() { return this; }
  read() { return this.chunks.shift() ?? null; }
  send(...chunks: string[]) { this.chunks.push(...chunks); this.emit("readable"); }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(history = new PromptHistory()) {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-composer-")); cleanups.push(() => rm(cwd, {recursive:true,force:true}));
  const requests: ModelRequest[] = []; const controller = new TuiController({cwd,agent:{run(){throw Error("unattached");}}});
  controller.attach(createAgent({provider:{id:"fixture",model:"fixture",capabilities:{tools:false,parallelTools:false,caching:false,contextWindow:100000},
    async *stream(req) { requests.push(req); yield {type:"text_delta",text:"reply"}; yield {type:"stop",reason:"end_turn"}; }},
    store:new SessionStore({root:join(cwd,"logs")}),tools:[],systemPrompt:"fixture",repoMap:false,permissions:new RulePolicy([])}));
  const input = new Input(); const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {columns:80,rows:24,isTTY:true,write:(text:string)=>{writes.push(text);return true;}});
  let mounted!: () => void; const ready = new Promise<void>(resolve => {mounted=resolve;});
  const ink = render(createElement(App,{controller,history,onMounted:mounted}), {stdin:input as never,stdout:output as never,patchConsole:false,exitOnCtrlC:false});
  cleanups.push(async()=>{ink.unmount();await controller.shutdown();await history.close();}); await ready;
  return {controller,input,writes,requests,history};
}
const lastPrompt = (requests: ModelRequest[]) => requests.at(-1)?.messages.filter(m=>m.role==="user").at(-1)?.content;
it.each(["", "\u001b[201~"])("actual Ink recalls/restores draft and submits multiline only on final Enter (protocol=%j)", async prefix => {
  const history = new PromptHistory(); history.remember("old\nmultiline");
  const f = await fixture(history);
  f.input.send("draft", prefix+"\u001b[A", prefix+"\u001b[B", prefix+"\r");
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:"draft"}));
  await vi.waitFor(()=>expect(f.controller.snapshot().status).toBe("idle"),{timeout:5000});
  f.input.send("line1\\",prefix+"\r");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("line1"));
  expect(f.requests).toHaveLength(1);
  f.input.send("line2",prefix+"\r");
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:"line1\nline2"}));
  expect(history.values()).toEqual(["old\nmultiline","draft","line1\nline2"]);
}, 15000);
it.each(["\u001b[13;2u", "\u001b[27;2;13~", "\u001b[201~\u001b[13;2u"])("actual distinguishable Shift-Enter inserts without submitting (%j)", async key => {
  const f = await fixture(); f.input.send("first",key,"second","\r");
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:"first\nsecond"}));
});
it.each(["", "\u001b[201~"])("completion uses loaded names and never dispatches a skill (protocol=%j)", async prefix => {
  const f = await fixture();
  f.controller.setSkills([{name:"help",body:"shadow"},{name:"Testing",body:"skill body"},{name:"terrible\u001bname",body:"bad"}] as Skill[]);
  expect(f.controller.completionNames().filter(n=>n==="help")).toHaveLength(1);
  expect(f.controller.completionNames()).not.toContain("terrible\u001bname");
  f.input.send("/Test",prefix+"\t");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("/Testing"));
  expect(f.requests).toHaveLength(0); expect(f.history.values()).toEqual([]);
  f.input.send(prefix+"\u001b[A"); expect(f.requests).toHaveLength(0);
});
it.each(["", "\u001b[201~"])("approval/question/escalation keys never recall or persist sensitive answers (protocol=%j)", async prefix => {
  const f = await fixture(); f.history.remember("OLD_PRIVATE_PROMPT");
  const permission = f.controller.ask({tool:"effect",class:"exec",input:{},cwd:process.cwd()});
  f.input.send(prefix+"\u001b[A",prefix+"\t",prefix+"n"); expect(await permission).toBe("deny");
  const question = f.controller.askQuestion({id:"00000000-0000-4000-8000-000000000001",sessionId:"fixture",toolUseId:"question",prompt:"Sensitive",options:["one"]},new AbortController().signal);
  f.input.send(prefix+"\u001b[A",prefix+"\t","ANSWER_CANARY",prefix+"\r");
  expect(await question).toMatchObject({source:"human",answer:{text:"ANSWER_CANARY"}});
  const escalation = f.controller.askSupervisor("Guidance?");
  f.input.send(prefix+"\u001b[A","ESCALATION_CANARY",prefix+"\r");
  expect(await escalation).toBe("answered");
  expect(f.history.values()).toEqual(["OLD_PRIVATE_PROMPT"]); expect(f.requests).toHaveLength(0);
});
it("bracketed paste preserves newlines, tabs and escape keys literally without recall or dispatch", async () => {
  const f = await fixture(); f.history.remember("not-paste");
  const pasted = "literal\n\t\u001b[A\\";
  f.input.send("\u001b[200~",pasted,"\u001b[201~");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("literal"));
  expect(f.requests).toHaveLength(0); expect(f.history.values()).toEqual(["not-paste"]);
  // Appending a character leaves the pasted trailing backslash literal on submit.
  f.input.send("x","\r"); await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:pasted+"x"}));
});
it("even trailing slashes submit literally and edits detach recall", async () => {
  const history = new PromptHistory(); history.remember("old"); const f = await fixture(history);
  f.input.send("\u001b[A"," edit","\u001b[B","\\\\","\r");
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:"old edit\\\\"}));
});
