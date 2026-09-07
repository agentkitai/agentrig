import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RulePolicy } from "@agentkitai/agentrig-core";
import { parseAttachments, completeAttachment, clipboardCommand, readClipboard } from "../src/tui/attachments.js";
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it("parses only explicit references; quoted spaces and literal at signs remain distinct",()=>{
  expect(parseAttachments('review @"my file.txt" and @image.png @@literal person@example.org')).toEqual({text:'review  and  @literal person@example.org',attachments:[{kind:"file",path:"my file.txt"},{kind:"file",path:"image.png"}]});
  expect(parseAttachments('@note')).toEqual({text:"",attachments:[{kind:"file",path:"note"}]});
  expect(()=>parseAttachments(Array(9).fill("@note").join(" "))).toThrow();
});
it("actual completion requires read authority, never exec; one-time ask only before bounded directory enumeration",async()=>{
  const root=await mkdtemp(join(tmpdir(),"agentrig-complete-"));roots.push(root);await writeFile(join(root,"sample.txt"),"PAYLOAD_NOT_READ");
  const ask=vi.fn(async()=>"deny" as const),signal=new AbortController().signal;
  await expect(completeAttachment("@sa",{cwd:root,permissions:new RulePolicy([{class:"read",decision:"deny"},{class:"exec",decision:"allow"}]),ask},signal)).rejects.toThrow("denied");expect(ask).not.toHaveBeenCalled();
  const yes=vi.fn(async()=>"allow" as const);
  expect(await completeAttachment("look @sa",{cwd:root,permissions:new RulePolicy([]),ask:yes},signal)).toEqual({text:"look @sample.txt ",hint:"sample.txt"});expect(yes).toHaveBeenCalledOnce();
  expect(yes.mock.calls[0]?.[0]).toMatchObject({class:"read",tool:"input_directory"});
  await expect(completeAttachment("@sa",{cwd:root,sandbox:"read-only",ask:yes},signal)).rejects.toThrow("sandbox");expect(yes).toHaveBeenCalledOnce();
});
it("caps completion scans rather than silently presenting a partial result",async()=>{
  const root=await mkdtemp(join(tmpdir(),"agentrig-complete-cap-"));roots.push(root);await Promise.all(Array.from({length:257},(_,i)=>writeFile(join(root,`f${i}`),"")));
  await expect(completeAttachment("@f",{cwd:root,permissions:new RulePolicy([{class:"read",decision:"allow"}]),ask:async()=>"deny"},new AbortController().signal)).rejects.toThrow("256");
});
it("uses verified fixed platform helper contracts; refuses remote DISPLAY and never executes these commands in tests",()=>{
  expect(clipboardCommand("darwin",{})).toEqual({command:"pngpaste",args:["-"]});
  expect(clipboardCommand("linux",{WAYLAND_DISPLAY:"wayland-0"}).args).toEqual(["--type","image/png","--no-newline"]);
  expect(clipboardCommand("linux",{DISPLAY:":0"}).args).toEqual(["-selection","clipboard","-t","image/png","-o"]);
  expect(()=>clipboardCommand("linux",{DISPLAY:"evil.example:0"})).toThrow();expect(clipboardCommand("win32",{}).args).toContain("-Sta");
});
it("actual inert child supplies PNG, malformed/overflow/error children refuse without leaking diagnostics",async()=>{
  const signal=new AbortController().signal;
  expect(await readClipboard(signal,{command:process.execPath,args:["-e",`process.stdout.write(Buffer.from('${png}','base64'))`]})).toEqual({kind:"clipboard",data:png});
  for(const script of ["process.stdout.write('garbage')","process.stdout.write(Buffer.alloc(4194305))","process.stderr.write('SECRET_DIAGNOSTIC');process.exit(1)"]){
    await expect(readClipboard(signal,{command:process.execPath,args:["-e",script]})).rejects.not.toThrow("SECRET_DIAGNOSTIC");
  }
});
it("cancels and joins an actual inert helper without accepting late bytes",async()=>{
  const abort=new AbortController(); const work=readClipboard(abort.signal,{command:process.execPath,args:["-e","setInterval(()=>{},1000)"]});
  abort.abort();await expect(work).rejects.toThrow("cancelled");
});
it("bounds the actual helper deadline and awaits process close",async()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const work=readClipboard(new AbortController().signal,{command:process.execPath,args:["-e","setInterval(()=>{},1000)"]});
  const assertion=expect(work).rejects.toThrow("timed out");await vi.advanceTimersByTimeAsync(2001);await assertion;
});
