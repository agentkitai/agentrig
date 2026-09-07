import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileMemoryStore, ingestSession, withMemoryLock } from "@agentkitai/agentrig-memory";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { PromptHistory, PromptRecall, completePrompt, HISTORY_LIMITS } from "../src/tui/prompt-history.js";
import { removeLastGrapheme } from "../src/tui/graphemes.js";

it.each([["", ""], ["a", ""], ["abc", "ab"], ["e\u0301x", "e\u0301"], ["kept😀", "kept"],
  ["kept👩🏽‍💻", "kept"], ["kept🇮🇱", "kept"], ["kept\r\n", "kept"], ["kept\n", "kept"],
  ["kept\ud83d", "kept"], ["kept\udc00", "kept"]])("removes only the final grapheme from %j", (text, expected) => {
  expect(removeLastGrapheme(text!)).toBe(expected);
});

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "agentrig-history-")); roots.push(path); return path; }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }); });
it("persists exact multiline records, bounds newest history and joins a burst on close", async () => {
  const path = await root(); const notices: string[] = [];
  const history = await PromptHistory.load(path, text => notices.push(text));
  history.remember("first\nsecond"); history.remember("first\nsecond"); await history.close();
  const again = await PromptHistory.load(path);
  expect(again.values()).toEqual(["first\nsecond"]);
  for (let i = 0; i < 220; i++) again.remember(`entry${i}`);
  await again.close();
  const contents = await readFile(join(path, ".agentrig/history"), "utf8");
  expect(JSON.parse(contents).entries).toHaveLength(200);
  expect(JSON.parse(contents).entries.at(-1)).toBe("entry219");
  expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(HISTORY_LIMITS.fileBytes);
  if (process.platform !== "win32") expect((await stat(join(path, ".agentrig/history"))).mode & 0o777).toBe(0o600);
  expect(notices).toEqual([]);
});
it("keeps concurrent cooperating instances without lost writes", async () => {
  const path = await root(); const a = await PromptHistory.load(path); const b = await PromptHistory.load(path);
  a.remember("one"); b.remember("two"); await Promise.all([a.close(), b.close()]);
  expect((await PromptHistory.load(path)).values().slice().sort()).toEqual(["one", "two"]);
});
it("bounded UTF-8 records and serialized bytes reject oversize without truncation", async () => {
  const path = await root(); const notices: string[] = []; const history = await PromptHistory.load(path, text => notices.push(text));
  const entry = "🙂".repeat(4096);
  history.remember(entry + "🙂");
  for (let i = 0; i < 40; i++) history.remember(String(i) + entry.slice(0, -2));
  await history.close();
  const text = await readFile(join(path, ".agentrig/history"), "utf8");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HISTORY_LIMITS.fileBytes);
  expect(JSON.parse(text).entries.at(-1)).toBe("39" + entry.slice(0, -2));
  expect(notices).toEqual(["Prompt too large for history; submitted text is unchanged."]);
});
it.each(["SECRET malformed", JSON.stringify({version:1,entries:[],extra:"secret"}), "x".repeat(HISTORY_LIMITS.fileBytes + 1)])("refuses malformed/oversized storage without overwrite or content disclosure (%#)", async text => {
  const path = await root(); await mkdir(join(path, ".agentrig")); const file = join(path, ".agentrig/history"); await writeFile(file, text);
  const notices: string[] = []; const history = await PromptHistory.load(path, text => notices.push(text));
  history.remember("memory-only"); await history.close();
  expect(history.values()).toEqual(["memory-only"]); expect(await readFile(file, "utf8")).toBe(text);
  expect(notices).toEqual(["Prompt history persistence unavailable; using memory only."]);
});
it("refuses directory and symbolic link history without overwriting targets", async () => {
  const path = await root(); await mkdir(join(path, ".agentrig/history"), { recursive:true });
  const history = await PromptHistory.load(path); history.remember("ignored"); await history.close();
  expect((await stat(join(path, ".agentrig/history"))).isDirectory()).toBe(true);
  const other = await root(); const target = join(other, "target"); await mkdir(target);
  await mkdir(join(other, ".agentrig")); await symlink(target, join(other, ".agentrig/history"), process.platform === "win32" ? "junction" : "dir");
  const linked = await PromptHistory.load(other); linked.remember("ignored"); await linked.close();
  expect((await stat(target)).isDirectory()).toBe(true);
});
it("memory-only mode never accesses a project and restores the draft without submitting", async () => {
  const history = await PromptHistory.load(); history.remember("one"); history.remember("two");
  const recall = new PromptRecall();
  expect(recall.move(-1, "draft", history.values())).toBe("two");
  expect(recall.move(-1, "two", history.values())).toBe("one");
  expect(recall.move(1, "one", history.values())).toBe("two");
  expect(recall.move(1, "two", history.values())).toBe("draft");
  recall.reset(); expect(recall.move(1, "edited", history.values())).toBe("edited");
  expect(completePrompt("/hel", ["help", "hello"])).toEqual({text:"/hel",hint:"/help  /hello"});
  expect(completePrompt("/HELP", ["help"])).toEqual({text:"/HELP ",hint:""});
  expect(completePrompt("/help arg", ["help"])).toEqual({text:"/help arg",hint:""});
});
it("a held cooperative lock fails boundedly, keeps prior storage and permits memory-only recall", async () => {
  const path = await root(); const history = await PromptHistory.load(path); history.remember("original"); await history.close();
  const notices: string[] = []; const next = await PromptHistory.load(path, text => notices.push(text));
  await withMemoryLock(join(path, ".agentrig/history"), async () => { next.remember("unsaved"); await next.close(); });
  expect(next.values()).toEqual(["original","unsaved"]);
  expect((await PromptHistory.load(path)).values()).toEqual(["original"]);
  expect(notices).toEqual(["Prompt history persistence unavailable; using memory only."]);
});
it("refuses an aliased metadata directory before any history read or write", async () => {
  const path = await root(); const outside = await root();
  await symlink(outside, join(path,".agentrig"), process.platform === "win32" ? "junction" : "dir");
  const history = await PromptHistory.load(path); history.remember("must-not-escape"); await history.close();
  await expect(readFile(join(outside,"history"))).rejects.toMatchObject({code:"ENOENT"});
});
it("actual ingest never reads history-only canaries but retains genuinely logged prompts", async () => {
  const project = await root(); const dir = join(project, ".agentrig");
  const history = await PromptHistory.load(project); history.remember("HISTORY_ONLY_PRIVATE_CANARY"); await history.close();
  const logPath = join(dir, "raw/sessions/s1.jsonl"); await mkdir(join(dir, "raw/sessions"), {recursive:true});
  await writeFile(logPath, [{type:"session.start",task:"GENUINE_SUBMITTED_PROMPT",cwd:project},{type:"session.end",reason:"done"}].map(e=>JSON.stringify(e)).join("\n")+"\n");
  const inputs: string[] = [];
  const provider: ModelProvider = {id:"fixture",model:"fixture",capabilities:{tools:false,parallelTools:false,caching:false,contextWindow:100000},async *stream(req) {
    const input = JSON.stringify(req); inputs.push(input);
    yield {type:"text_delta",text:JSON.stringify({summary:["GENUINE_SUBMITTED_PROMPT","HISTORY_ONLY_PRIVATE_CANARY"].filter(word=>input.includes(word)).join(" "),facts:[]})}; yield {type:"stop",reason:"end_turn"};
  }};
  const store = new FileMemoryStore({root:join(dir,"wiki")}); await store.init();
  await ingestSession({store,provider,sessionId:"s1",logPath,project:"fixture"});
  expect(inputs.join("\n")).toContain("GENUINE_SUBMITTED_PROMPT");
  expect(inputs.join("\n")).not.toContain("HISTORY_ONLY_PRIVATE_CANARY");
  expect(JSON.stringify(await store.pages())).toContain("GENUINE_SUBMITTED_PROMPT");
  expect(JSON.stringify(await store.pages())).not.toContain("HISTORY_ONLY_PRIVATE_CANARY");
});
