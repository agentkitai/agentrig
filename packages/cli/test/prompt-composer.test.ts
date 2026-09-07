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
async function fixture(history = new PromptHistory(), columns = 80, rows = 24) {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-composer-")); cleanups.push(() => rm(cwd, {recursive:true,force:true}));
  const requests: ModelRequest[] = []; const controller = new TuiController({cwd,agent:{run(){throw Error("unattached");}}});
  controller.attach(createAgent({provider:{id:"fixture",model:"fixture",capabilities:{tools:false,parallelTools:false,caching:false,contextWindow:100000},
    async *stream(req) { requests.push(req); yield {type:"text_delta",text:"reply"}; yield {type:"stop",reason:"end_turn"}; }},
    store:new SessionStore({root:join(cwd,"logs")}),tools:[],systemPrompt:"fixture",repoMap:false,permissions:new RulePolicy([])}));
  const input = new Input(); const writes: string[] = [], unreadAtWrite: number[] = [];
  const output = Object.assign(new EventEmitter(), {columns,rows,isTTY:true,write:(text:string)=>{writes.push(text);unreadAtWrite.push(input.chunks.length);return true;}});
  let mounted!: () => void; const ready = new Promise<void>(resolve => {mounted=resolve;});
  const ink = render(createElement(App,{controller,history,onMounted:mounted}), {stdin:input as never,stdout:output as never,patchConsole:false,exitOnCtrlC:false});
  cleanups.push(async()=>{ink.unmount();await controller.shutdown();await history.close();}); await ready;
  return {controller,input,writes,requests,history,unreadAtWrite};
}
const lastPrompt = (requests: ModelRequest[]) => requests.at(-1)?.messages.filter(m=>m.role==="user").at(-1)?.content;
const graphemes = ["😀", "e\u0301", "👩🏽‍💻", "🇮🇱", "👨‍👩‍👧‍👦"];
it.each(["", "\u001b[201~"])("backspace removes whole graphemes in actual prompt input (%j)", async prefix => {
  const f=await fixture();
  for (const [index,grapheme] of graphemes.entries()) {
    f.input.send(`kept${index}`,grapheme,prefix+"\u007f",prefix+"\r");
    await vi.waitFor(()=>{expect(f.requests).toHaveLength(index+1);expect(f.controller.snapshot().status).toBe("idle");},{timeout:5000});
    expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:`kept${index}`}));
  }
});
it.each(["", "\u001b[201~"])("backspace removes whole graphemes from an unconfirmed permission scope (%j)",async prefix=>{
  const f=await fixture();
  const answer=f.controller.ask({tool:"file",class:"write",input:{},paths:[join(process.cwd(),"file")],cwd:process.cwd()});
  f.input.send(prefix+"s");expect(f.controller.snapshot().pending?.scope).toBeDefined();
  const original=f.controller.snapshot().pending!.scope!.text;
  for (const grapheme of graphemes) {
    f.input.send(grapheme,prefix+"\u007f");
    expect(f.controller.snapshot().pending?.scope?.text).toBe(original);
    expect(f.controller.permissionGrants.list()).toEqual([]);
  }
  f.controller.cancelPermissionScope();f.input.send(prefix+"n");expect(await answer).toBe("deny");
  expect(f.requests).toEqual([]);expect(f.history.values()).toEqual([]);
});
it.each(["", "\u001b[201~"])("grapheme editing preserves protected question and supervisor answer semantics (%j)",async prefix=>{
  const f=await fixture();
  const question=f.controller.askQuestion({id:"00000000-0000-4000-8000-000000000001",sessionId:"fixture",toolUseId:"question",prompt:"Question",options:["one"]},new AbortController().signal);
  f.input.send("kept👩🏽‍💻",prefix+"\u007f",prefix+"\r");expect(await question).toMatchObject({answer:{text:"kept"}});
  const escalation=f.controller.askSupervisor("Guidance");
  f.input.send("kept🇮🇱",prefix+"\u007f");
  await vi.waitFor(()=>expect(f.writes.at(-1)).toContain("answer: kept"));
  expect(f.writes.at(-1)).not.toContain("🇮");
  f.input.send(prefix+"\r");expect(await escalation).toBe("answered");
  expect(f.history.values()).toEqual([]);expect(f.requests).toEqual([]);expect(f.controller.permissionGrants.list()).toEqual([]);
});
it("backspace inside a framed paste remains literal text",async()=>{
  const f=await fixture();const text="kept😀\u007f";
  f.input.send("\u001b[200~",text,"\u001b[201~","\r");
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text}));
});
it.each(["", "\u001b[201~"])("suggestion selection redraws even when the wall clock does not advance (%j)", async prefix => {
  const now=vi.spyOn(Date,"now").mockReturnValue(42);
  try {
    const f=await fixture();f.controller.setSkills([{name:"ClockA",body:"a"},{name:"ClockB",body:"b"}] as Skill[]);
    f.input.send(prefix+"/");await vi.waitFor(()=>expect(f.writes.join("")).toContain("› /ClockA [skill]"));
    f.writes.length=0;f.input.send(prefix+"\u001b[B");
    await vi.waitFor(()=>expect(f.writes.join("")).toContain("› /ClockB [skill]"));
    expect(f.requests).toEqual([]);
  } finally {now.mockRestore();}
});
it.each(["", "\u001b[201~"])("typing slash automatically discovers skills and navigates beyond eight without execution (%j)", async prefix => {
  const f = await fixture();
  f.controller.setSkills(Array.from({length:12}, (_,i) => ({name:`zskill${String(i).padStart(2,"0")}`,body:"not executed"})) as Skill[]);
  f.input.send(prefix+"/");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("/zskill00 [skill]"));
  expect(f.requests).toHaveLength(0); expect(f.history.values()).toEqual([]);
  for (let i=0;i<10;i++) f.input.send(prefix+"\u001b[B");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("› /zskill10 [skill]"));
  f.input.send(prefix+"\t");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("> /zskill10"));
  f.input.send("argument");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("> /zskill10 argument"));
  expect(f.requests).toHaveLength(0); expect(f.history.values()).toEqual([]);
});
it.each(["", "\u001b[201~"])("slash suggestions filter and close on arguments without changing typed Enter semantics (%j)", async prefix => {
  const f = await fixture(); f.controller.setSkills([{name:"ZebraSkill",body:"never run"}] as Skill[]);
  f.input.send(prefix+"/"); await vi.waitFor(() => expect(f.writes.join("")).toContain("/ZebraSkill [skill]"));
  f.writes.length=0; f.input.send(prefix+"he");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("/help [command]"));
  expect(f.writes.join("")).not.toContain("/ZebraSkill [skill]");
  f.writes.length=0; f.input.send(prefix+"lp ");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("> /help"));
  expect(f.writes.join("")).not.toContain("[command]");
  f.input.send(prefix+"\r");
  await vi.waitFor(() => expect(f.controller.snapshot().lines.some(line=>line.text.includes("/skills"))).toBe(true));
  expect(f.requests).toHaveLength(0);
});
it("pasted slash and protected prompts do not open or act on suggestions", async () => {
  const f = await fixture(); f.controller.setSkills([{name:"SkillCanary",body:"never run"}] as Skill[]);
  f.input.send("\u001b[200~/\u001b[201~");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("> /"));
  expect(f.writes.join("")).not.toContain("[skill]");
  f.input.send("\u007f", "/"); await vi.waitFor(() => expect(f.writes.join("")).toContain("[skill]"));
  f.writes.length=0;
  const permission=f.controller.ask({tool:"effect",class:"exec",input:{},cwd:process.cwd()});
  await vi.waitFor(() => expect(f.writes.join("")).toContain("allow once"));
  expect(f.writes.at(-1)).not.toContain("[skill]");
  f.input.send("/", "\t", "\u001b[B"); expect(f.controller.snapshot().pending).not.toBeNull();
  f.input.send("n"); expect(await permission).toBe("deny"); expect(f.requests).toHaveLength(0);
});
it.each(["", "\u001b[201~"])("slash text remains an answer, not a menu, in question and supervisor prompts (%j)", async prefix => {
  const f=await fixture();f.controller.setSkills([{name:"SkillCanary",body:"never run"}] as Skill[]);
  const question=f.controller.askQuestion({id:"00000000-0000-4000-8000-000000000001",sessionId:"fixture",toolUseId:"question",prompt:"QuestionCanary",options:["one"]},new AbortController().signal);
  f.input.send(prefix+"/");await vi.waitFor(()=>expect(f.writes.join("")).toContain("answer: /"));
  expect(f.writes.join("")).not.toContain("[skill]");
  f.input.send(prefix+"\t",prefix+"\u001b[B",prefix+"\r");
  expect(await question).toMatchObject({answer:{text:"/"}});
  f.writes.length=0;const escalation=f.controller.askSupervisor("GuidanceCanary");
  f.input.send(prefix+"/");await vi.waitFor(()=>expect(f.writes.join("")).toContain("answer: /"));
  expect(f.writes.join("")).not.toContain("[skill]");
  f.input.send(prefix+"\t",prefix+"\u001b[B",prefix+"\r");expect(await escalation).toBe("answered");
  expect(f.history.values()).toEqual([]);expect(f.requests).toEqual([]);
});
it.each([[80,8],[80,12],[80,24],[120,8],[120,12],[120,24]])("slash list or tiny-terminal status fallback shares the frame budget at %sx%s without mid-input writes", async (columns, rows) => {
  const f = await fixture(new PromptHistory(), columns, rows);
  f.controller.setSkills(Array.from({length:20},(_,i)=>({name:`Skill${String(i).padStart(2,"0")}`+"x".repeat(80),body:"never run"})) as Skill[]);
  f.controller.print(Array.from({length:300},(_,i)=>`SCROLLBACK_${i}`).join("\n"),"event");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("SCROLLBACK_299"));
  f.writes.length=0; f.unreadAtWrite.length=0;
  f.input.send("/");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("/Skill00"));
  f.input.send(...Array.from({length:15},()=>"\u001b[B"));
  await vi.waitFor(() => expect(f.writes.join("")).toContain("/Skill15"));
  expect(f.writes.join("")).not.toContain("\u001b[2J");
  expect(f.writes.join("")).not.toContain("SCROLLBACK_");
  expect(f.unreadAtWrite.every(count=>count===0)).toBe(true);
  expect(f.requests).toHaveLength(0);
});
it("decoded Escape dismisses suggestions at the next safe terminal draw",async()=>{
  const f=await fixture();f.controller.setSkills([{name:"EscapeSkill",body:"never run"}] as Skill[]);
  f.input.send("/");await vi.waitFor(()=>expect(f.writes.join("")).toContain("[skill]"));
  f.writes.length=0;
  // The second Escape releases the first but leaves a possible marker prefix.
  // Tab disproves that prefix and gives the existing decoder a safe draw point.
  f.input.send("\u001b","\u001b","\t");
  await vi.waitFor(()=>expect(f.writes.length).toBeGreaterThan(0));
  expect(f.writes.join("")).not.toContain("[skill]");expect(f.requests).toEqual([]);
});
it("actual Ink completes model selection without creating a model prompt", async () => {
  const f = await fixture(); let entry = "first";
  const info = () => ({ entry, provider: "fixture", model: entry });
  f.controller.setProviderSelection({ current: info, describe: () => [], prepare: (_kind, value) => () => { entry = value; return info(); } });
  expect(f.controller.completionNames()).toEqual(expect.arrayContaining(["model", "effort"]));
  f.input.send("/mod", "\t");
  await vi.waitFor(() => expect(f.writes.join("")).toContain("/model"));
  expect(f.requests).toHaveLength(0);
  f.input.send(" second", "\r");
  await vi.waitFor(() => expect(f.controller.snapshot().providerSelection?.entry).toBe("second"));
  expect(f.requests).toHaveLength(0);
});
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
it.each(["\u001b[13;2u", "\u001b[27;2;13~", "prefix\u001b[13;2u", "prefix\u001b[27;2;13~"])("coalesced supported Shift-Enter preserves both edges without implicit submission (%j)", async key => {
  const f = await fixture(); f.input.send("first",key+"second\rthird");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("third"));
  expect(f.requests).toHaveLength(0);
  f.input.send("\r"); await vi.waitFor(()=>expect(f.requests).toHaveLength(1),{timeout:5000});
  expect(lastPrompt(f.requests)).toContainEqual(expect.objectContaining({type:"text",text:`first${key.startsWith("prefix") ? "prefix" : ""}\nsecond\nthird`}));
});
it("coalesced Shift-Enter does not auto-answer a question or authorize a permission", async () => {
  const f = await fixture(); const permission = f.controller.ask({tool:"effect",class:"exec",input:{},cwd:process.cwd()});
  f.input.send("\u001b[13;2uy\r");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("effect"));
  expect(f.controller.snapshot().pending).not.toBeNull(); f.input.send("n"); expect(await permission).toBe("deny");
  const question = f.controller.askQuestion({id:"00000000-0000-4000-8000-000000000001",sessionId:"fixture",toolUseId:"question",prompt:"Sensitive",options:["one"]},new AbortController().signal);
  f.input.send("\u001b[13;2uANSWER\rCANARY");
  await vi.waitFor(()=>expect(f.writes.join("")).toContain("CANARY"));
  expect(f.controller.snapshot().question).not.toBeNull();
  f.input.send("\r"); expect(await question).toMatchObject({source:"human",answer:{text:"ANSWER\nCANARY"}});
  expect(f.history.values()).toEqual([]); expect(f.requests).toHaveLength(0);
});
