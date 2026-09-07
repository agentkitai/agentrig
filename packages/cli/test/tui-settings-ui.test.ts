import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/tui/app.js";
import { TuiController } from "../src/tui/controller.js";
import { PromptHistory } from "../src/tui/prompt-history.js";
import type { TuiSettings } from "../src/tui/settings.js";

class Input extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding() {} setRawMode() {} ref() {} unref() {} read() { return this.chunks.shift() ?? null; }
  send(...chunks: string[]) { this.chunks.push(...chunks); this.emit("readable"); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const custom: TuiSettings = { theme: "light", keybindings: { permission: { allowOnce: "q", denyOnce: "w", allowSession: "r", denySession: "t", scope: "u", editScope: "i" }, historyPrevious: "ctrl-p", historyNext: "ctrl-n", abort: "ctrl-g" } };
async function mount(settings: TuiSettings = custom, columns = 80) {
  const controller = new TuiController({ cwd: process.cwd(), agent: { run() { throw Error("no provider dispatch expected"); } } });
  const input = new Input(), writes: string[] = [], history = new PromptHistory(); history.remember("HISTORY_CANARY");
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 30, isTTY: true, write(text: string) { writes.push(text); return true; } });
  let ready!: () => void; const mounted = new Promise<void>(resolve => { ready = resolve; });
  const ink = render(createElement(App, { controller, settings, history, onMounted: ready }), { stdin: input as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(async () => { ink.unmount(); await controller.shutdown(); await history.close(); }); await mounted;
  return { controller, input, writes, history };
}
it.each(["", "\u001b[201~"])("remapped permission/session/scope keys and immutable escape work through actual Ink (%j)", async prefix => {
  const f = await mount(); const send = (s: string) => f.input.send(prefix + s);
  const req = { tool: "file_tool", class: "write" as const, input: {}, cwd: process.cwd(), paths: ["a"] };
  for (const [key, result, standing] of [["q", "allow", false], ["w", "deny", false], ["r", "allow", true], ["t", "deny", true]] as const) {
    f.controller.permissionGrants.clear(); const answer = f.controller.ask(req);
    send("y"); expect(f.controller.snapshot().pending).not.toBeNull();
    send(key.toUpperCase()); expect(await answer).toBe(result);
    expect(f.controller.permissionGrants.list()).toHaveLength(standing ? 1 : 0);
  }
  f.controller.permissionGrants.clear(); const answer = f.controller.ask(req);
  f.input.send("\u001b[200~qru\u0007\u001b[201~"); expect(f.controller.snapshot().pending).not.toBeNull();
  send("u"); expect(f.controller.snapshot().pending?.scope).toBeDefined();
  // A preview and confirmation in one raw protocol chunk never install authority.
  f.input.send("\u001b[201~\rq"); expect(f.controller.snapshot().pending?.scope?.preview).toBe(true);
  expect(f.controller.permissionGrants.list()).toHaveLength(0);
  send("w"); expect(f.controller.snapshot().pending?.scope).toBeUndefined();
  send("u"); send("\r");
  send("i"); expect(f.controller.snapshot().pending?.scope?.preview).toBe(false);
  send("\r"); await vi.waitFor(() => expect(f.writes.join("")).toContain("q = confirm grant"));
  send("q"); expect(await answer).toBe("allow"); expect(f.controller.permissionGrants.list()).toHaveLength(1);
  f.controller.permissionGrants.clear();
  const denied = f.controller.ask(req); send("\u001b"); send("\u001b"); expect(await denied).toBe("deny");
});
it.each(["", "\u001b[201~"])("history/abort mappings respect protected prompts and preserve pasted bytes (%j)", async prefix => {
  const f = await mount(); const submitted: string[] = [];
  vi.spyOn(f.controller, "submit").mockImplementation(async text => { submitted.push(text); return true; });
  f.input.send("draft", prefix + "\u0010", prefix + "\u000e", prefix + "\r");
  await vi.waitFor(() => expect(submitted).toEqual(["draft"]));
  f.input.send(prefix + "\u0010", prefix + "\r");
  await vi.waitFor(() => expect(submitted).toHaveLength(2)); expect(submitted[1]).toBe("draft");
  const question = f.controller.askQuestion({ id: "00000000-0000-4000-8000-000000000001", sessionId: "fixture", toolUseId: "q", prompt: "Question", options: ["one"] }, new AbortController().signal);
  f.input.send(prefix + "\u0010", "ANSWER", prefix + "\r");
  expect(await question).toMatchObject({ answer: { text: "ANSWER" } }); expect(f.history.values()).not.toContain("ANSWER");
  const abort = vi.spyOn(f.controller, "abort").mockImplementation(() => {}); vi.spyOn(f.controller, "inputBusy").mockReturnValue(true);
  f.input.send("\u001b[200~q\u0010\u0007\u0003\u001b[201~", prefix + "\r");
  await vi.waitFor(() => expect(submitted).toHaveLength(3)); expect(submitted[2]).toBe("q\u0010\u0007\u0003"); expect(abort).not.toHaveBeenCalled();
  f.input.send(prefix + "\u0007", prefix + "\u0003"); expect(abort).toHaveBeenCalledTimes(2);
});
it.each([80, 120])("NO_COLOR removes all TUI SGR with FORCE_COLOR at %s columns including Markdown and captured ANSI", async columns => {
  vi.stubEnv("NO_COLOR", ""); vi.stubEnv("FORCE_COLOR", "3");
  const f = await mount(custom, columns);
  f.controller.print("**MARKDOWN_CANARY**\n```ts\nconst x = 1;\n```", "assistant");
  f.controller.print("\u001b[32m+DIFF_CANARY\u001b[0m", "event");
  const ask = f.controller.ask({ tool: "effect", class: "exec", cwd: process.cwd(), input: {} });
  await vi.waitFor(() => expect(f.writes.join("")).toContain("q = allow once"));
  expect(f.writes.join("")).toContain("MARKDOWN_CANARY"); expect(f.writes.join("")).toContain("DIFF_CANARY");
  expect(f.writes.join("")).not.toMatch(/\u001b\[[0-9;:]*m/);
  f.input.send("w"); expect(await ask).toBe("deny");
});
it.each([80, 120])("fresh-process actual Ink honours dark/light and NO_COLOR before FORCE_COLOR at %s columns", async columns => {
  // Chalk samples support at module load: a fresh process, not post-import env mutation,
  // proves both the positive coloured path and NO_COLOR overriding forced Ink colours.
  const script = `import {EventEmitter} from 'node:events'; import {createElement} from 'react'; import {render} from 'ink';
    import {App} from ${JSON.stringify(new URL("../dist/tui/app.js", import.meta.url).href)};
    import {TuiController} from ${JSON.stringify(new URL("../dist/tui/controller.js", import.meta.url).href)};
    const controller=new TuiController({cwd:process.cwd(),agent:{run(){throw Error('no dispatch');}}});
    controller.print('**MARKDOWN_CANARY**','assistant');controller.print('\\u001b[32m+DIFF_CANARY\\u001b[0m','event');
    const writes=[];const stdout=Object.assign(new EventEmitter(),{columns:${columns},rows:30,isTTY:true,write:s=>{writes.push(s);return true;}});
    const stdin=Object.assign(new EventEmitter(),{isTTY:true,setEncoding(){},setRawMode(){},ref(){},unref(){},read(){return null;}});
    let ready;const mounted=new Promise(r=>ready=r);const app=render(createElement(App,{controller,settings:{theme:process.env.TEST_THEME},onMounted:ready}),{stdout,stdin,patchConsole:false,exitOnCtrlC:false});
    await mounted;app.unmount();await controller.shutdown();process.stdout.write(JSON.stringify(writes.join('')));`;
  const run = async (theme: string, noColor: boolean) => {
    const env = { ...process.env, FORCE_COLOR: "3", TEST_THEME: theme }; delete env.NO_COLOR;
    if (noColor) Object.assign(env, { NO_COLOR: "" });
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, timeout: 10000, maxBuffer: 100000 });
    return JSON.parse(result.stdout) as string;
  };
  expect(await run("dark", false)).toContain("\u001b[32m>");
  expect(await run("light", false)).toContain("\u001b[34m>");
  const plain = await run("light", true); expect(plain).toContain("MARKDOWN_CANARY"); expect(plain).toContain("DIFF_CANARY");
  expect(plain).not.toMatch(/\u001b\[[0-9;:]*m/);
}, 30000);
it.each(["", "\u001b[201~"])("non-ASCII case folding cannot answer a custom ASCII permission (%j)", async prefix => {
  const f = await mount({ keybindings: { permission: { allowOnce: "k" } } });
  const answer = f.controller.ask({ tool: "effect", class: "exec", cwd: process.cwd(), input: {} });
  f.input.send(prefix + "K"); expect(f.controller.snapshot().pending).not.toBeNull();
  if (prefix === "") { f.input.send("kk"); expect(f.controller.snapshot().pending).not.toBeNull(); }
  f.input.send(prefix + "K"); expect(await answer).toBe("allow");
});
