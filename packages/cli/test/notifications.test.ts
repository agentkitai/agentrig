import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createAgent, RulePolicy, SessionStore, type ModelProvider, type Agent } from "@agentkitai/agentrig-core";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/tui/app.js";
import { TuiController } from "../src/tui/controller.js";
import { desktopCommand, desktopDelivery, mountNotifications, type NotificationOptions, type Notifications, type DesktopDelivery } from "../src/tui/notifications.js";
import { ownedProcess } from "../src/owned-process.js";
import { reviewProcess } from "../src/review-process.js";
import { parseConfigText, resolveConfig } from "../src/config.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.useRealTimers(); });
class Input extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding() { return this; } setRawMode() { return this; } ref() { return this; } unref() { return this; }
  read() { return this.chunks.shift() ?? null; }
  send(text: string) { this.chunks.push(text); this.emit("readable"); }
}
async function mount(options: NotificationOptions = {}, desktop?: DesktopDelivery, agent?: Agent) {
  vi.useFakeTimers();
  const writes: string[] = [], input = new Input();
  const output = Object.assign(new EventEmitter(), { columns: 100, rows: 30, isTTY: true, write: (s: string) => { writes.push(s); return true; } });
  const controller = new TuiController({ cwd: process.cwd(), agent: agent ?? { run() { throw Error("unused"); } } });
  let notifier: Notifications | undefined;
  const app = render(createElement(App, { controller,
    onMounted: () => { notifier = mountNotifications(controller, { notificationIdleSeconds: 1, ...options }, { stdin: input, stdout: output, ...(desktop ? { desktop } : {}), now: Date.now }); },
    onInput: () => notifier?.input(),
  }), { stdin: input as never, stdout: output as never, patchConsole: false, exitOnCtrlC: false });
  await vi.advanceTimersByTimeAsync(50);
  expect(notifier).toBeDefined();
  cleanup.push(async () => { await notifier!.close(); await controller.shutdown(); app.unmount(); });
  return { controller, input, writes, notifier: notifier!, bells: () => writes.filter(w => w === "\u0007").length };
}
const permission = { tool: "private-tool-name", class: "exec" as const, input: { secret: "never-send" }, cwd: process.cwd() };
const question = { prompt: "PRIVATE PROMPT", options: ["one", "two"], id: "00000000-0000-4000-8000-000000000001", sessionId: "fixture", toolUseId: "q" };

it.each([{}, { notifications: "off" as const }, { notifications: "both" as const, headless: true }])("mounted TTY default/off/headless guard stays silent: %j", async options => {
  const desktop = vi.fn(async () => {}), h = await mount(options, desktop);
  const ask = h.controller.ask(permission); await vi.advanceTimersByTimeAsync(3000);
  expect(h.bells()).toBe(0); expect(desktop).not.toHaveBeenCalled(); h.controller.answerPermission("deny"); await ask;
});
it("actual App input resets idle; permission ask emits one BEL and no model text", async () => {
  const h = await mount({ notifications: "bell" }); const ask = h.controller.ask(permission);
  await vi.advanceTimersByTimeAsync(700); h.input.send("x"); await vi.advanceTimersByTimeAsync(500);
  expect(h.bells()).toBe(0); await vi.advanceTimersByTimeAsync(600); expect(h.bells()).toBe(1);
  h.controller.print("redraw"); await vi.advanceTimersByTimeAsync(4000); expect(h.bells()).toBe(1);
  h.controller.answerPermission("deny"); await ask;
});
it("permission/question/supervisor arbitration notifies actual visible identities once", async () => {
  const desktop = vi.fn(async () => {}), h = await mount({ notifications: "both" }, desktop);
  const escalation = h.controller.askSupervisor("PRIVATE escalation");
  const q = h.controller.askQuestion(question, new AbortController().signal);
  const p = h.controller.ask(permission);
  await vi.advanceTimersByTimeAsync(1100); expect(desktop.mock.calls[0]?.[0]).toBe("permission");
  h.controller.answerPermission("deny"); await p; await vi.advanceTimersByTimeAsync(2100);
  expect(desktop.mock.calls[1]?.[0]).toBe("question");
  h.controller.answerQuestionText("1"); await q; await vi.advanceTimersByTimeAsync(2100);
  expect(desktop.mock.calls[2]?.[0]).toBe("supervisor");
  h.controller.snapshot().escalation!.resolve(null, "closed"); await escalation;
  expect(h.bells()).toBe(3); expect(JSON.stringify(desktop.mock.calls)).not.toContain("PRIVATE");
});
it("answered/cancelled old prompts cannot deliver when a queued timer fires", async () => {
  const desktop = vi.fn(async () => {}), h = await mount({ notifications: "both" }, desktop);
  const abort = new AbortController(); const q = h.controller.askQuestion(question, abort.signal);
  await vi.advanceTimersByTimeAsync(500); abort.abort(); await q;
  await vi.advanceTimersByTimeAsync(3000); expect(h.bells()).toBe(0); expect(desktop).not.toHaveBeenCalled();
});
it("unmount aborts and joins one owned delivery; no queued desktop runs afterward", async () => {
  let joined = false;
  const desktop = vi.fn(async (_kind: string, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { joined = true; resolve(); }, { once: true }));
  });
  const h = await mount({ notifications: "desktop" }, desktop); const p = h.controller.ask(permission);
  await vi.advanceTimersByTimeAsync(1100); expect(desktop).toHaveBeenCalledTimes(1);
  await h.notifier.close(); expect(joined).toBe(true); h.controller.answerPermission("deny"); await p;
  await vi.advanceTimersByTimeAsync(3000); expect(desktop).toHaveBeenCalledTimes(1);
});
it("fixed desktop commands have no model values and unsupported platforms refuse", () => {
  expect(desktopCommand("win32", "permission")).toBeUndefined();
  expect(desktopCommand("linux", "question")).toEqual({ program: "/usr/bin/notify-send", args: ["--app-name=AgentRig", "--", "AgentRig", "A question answer is needed"] });
  expect(desktopCommand("darwin", "end")).toEqual({ program: "/usr/bin/osascript", args: ["-e", 'display notification "The session ended" with title "AgentRig"'] });
});

it("actual desktop wrapper fixes argv/environment/bounds and refuses missing or cancelled preparation", async () => {
  const run = vi.fn(async () => "ignored"), check = vi.fn(async () => {}), abort = new AbortController();
  const deliver = desktopDelivery({ platform: "linux", check, run, env: { DISPLAY: ":1", OPENAI_API_KEY: "secret", PATH: "/malicious", NODE_OPTIONS: "malicious" } });
  await deliver("permission", abort.signal);
  expect(run.mock.calls[0]).toEqual(["/usr/bin/notify-send", ["--app-name=AgentRig", "--", "AgentRig", "A permission answer is needed"],
    { cwd: "/", env: { DISPLAY: ":1" }, signal: abort.signal, timeoutMs: 2000, maxBytes: 4096, errorMessage: "desktop notification unavailable" }]);
  check.mockRejectedValueOnce(Error("absent")); await expect(deliver("end", abort.signal)).rejects.toThrow("absent");
  check.mockImplementationOnce(async () => { abort.abort(); }); await expect(deliver("end", abort.signal)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});

it("config validates bounded operator controls and explicit off overrides enabled config", () => {
  const project = parseConfigText("fixture", '{"notifications":"both","notificationIdleSeconds":30}');
  expect(resolveConfig({ defaults: { notifications: "off" }, project, cli: { notifications: "off" } }).notifications).toBe("off");
  for (const value of [{ notifications: true }, { notifications: "execute" }, { notificationIdleSeconds: 0 },
    { notificationIdleSeconds: 3601 }, { notificationIdleSeconds: 1.1 }, { notificationIdleSeconds: "2" }])
    expect(() => parseConfigText("fixture", JSON.stringify(value))).toThrow();
});

it("already-notified question stays deduplicated while a permission temporarily covers it", async () => {
  const desktop = vi.fn(async () => {}), h = await mount({ notifications: "desktop" }, desktop);
  const q = h.controller.askQuestion(question, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1100); expect(desktop).toHaveBeenCalledTimes(1);
  const p = h.controller.ask(permission); await vi.advanceTimersByTimeAsync(2100); expect(desktop).toHaveBeenCalledTimes(2);
  h.controller.answerPermission("deny"); await p; await vi.advanceTimersByTimeAsync(3000);
  expect(desktop).toHaveBeenCalledTimes(2); h.controller.answerQuestionText("1"); await q;
});

it("desktop failure is bounded once-only diagnostic and bell mode still works", async () => {
  const h = await mount({ notifications: "both" }, async () => { throw Error("private backend diagnostic"); });
  for (let i = 0; i < 2; i++) {
    const p = h.controller.ask(permission); await vi.advanceTimersByTimeAsync(2100); h.controller.answerPermission("deny"); await p;
  }
  expect(h.bells()).toBe(2);
  expect(h.controller.snapshot().lines.filter(line => line.text.includes("Desktop notifications unavailable"))).toHaveLength(1);
  expect(JSON.stringify(h.controller.snapshot().lines)).not.toContain("private backend diagnostic");
});
it("shared owned-process extraction retains actual review wrapper and notification-size bounds", async () => {
  const signal = new AbortController().signal;
  expect(await reviewProcess("git", ["--version"], { cwd: process.cwd(), signal })).toContain("git version");
  await expect(ownedProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(5000))'], {
    cwd: process.cwd(), env: {}, signal, timeoutMs: 2000, maxBytes: 4096, errorMessage: "bounded notification fixture",
  })).rejects.toThrow("bounded notification fixture");
});

it("review wrapper preserves rejected-promise behavior for pre-aborted calls", async () => {
  const abort = new AbortController(); abort.abort(); let result: Promise<string> | undefined;
  expect(() => { result = reviewProcess("git", ["--version"], { cwd: process.cwd(), signal: abort.signal }); }).not.toThrow();
  await expect(result).rejects.toThrow();
});

it("actual completed run notifies only after observed idle and never replays completion on redraw", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-notify-end-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { await gate; yield { type: "text_delta", text: "finished" }; yield { type: "stop", reason: "end_turn" }; } };
  const h = await mount({ notifications: "bell" }, undefined, createAgent({ provider, store: new SessionStore({ root }), tools: [], repoMap: false,
    systemPrompt: "fixture", permissions: new RulePolicy([], "deny") }));
  const running = h.controller.submit("task");
  await vi.advanceTimersByTimeAsync(1100); finish(); await running; await vi.advanceTimersByTimeAsync(10);
  expect(h.bells()).toBe(1); h.controller.print("redraw"); await vi.advanceTimersByTimeAsync(3000); expect(h.bells()).toBe(1);
});

it("a prompt resolved during desktop preparation cancels before the delayed backend sends", async () => {
  let release!: () => void, sent = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await mount({ notifications: "desktop" }, async (_kind, signal) => { await gate; signal.throwIfAborted(); sent++; });
  const p = h.controller.ask(permission); await vi.advanceTimersByTimeAsync(1100);
  h.controller.answerPermission("deny"); await p; release(); await vi.advanceTimersByTimeAsync(1);
  expect(sent).toBe(0);
});

it("real headless CLI with trusted notification config emits no BEL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-notify-cli-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agentrig"));
  await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ notifications: "bell", notificationIdleSeconds: 1, ingestOnEnd: false }));
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part; requests.push(JSON.parse(body));
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listener missing");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const output = await ownedProcess(process.execPath, [cli, "run", "task", "--headless", "--trust", "--provider", "openai", "--model", "fixture",
    "--base-url", `http://127.0.0.1:${address.port}/v1`, "--root", join(root, "sessions"), "--no-generated-skills"], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, OPENAI_API_KEY: "fixture-not-real" }, signal: new AbortController().signal,
    timeoutMs: 10000, maxBytes: 65536, errorMessage: "headless notification fixture failed",
  });
  expect(requests).toHaveLength(1); expect(output).toContain("complete"); expect(output).not.toContain("\u0007");
});
