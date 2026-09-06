import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { builtinTools, createAgent, RulePolicy, SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.js";
import { waitForTuiState } from "./tui-readiness.js";
import { renderChatEvent } from "../src/render.js";

it.each([80, 120])("actual %s-column Ink asks show proposed excerpt and completed edit shows captured unified diff", async columns => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-diff-ink-"));
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 30, isTTY: true,
    write: (value: string) => { writes.push(value); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read: () => null });
  const controller = new TuiController({ cwd, agent: { run: () => { throw new Error("not wired"); } } as never });
  let turn = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (turn++ === 0) { yield { type: "tool_use", name: "edit_file", id: "edit", input: { path: "target.txt", oldText: "old", newText: "new" } }; yield { type: "stop", reason: "tool_use" }; }
      else { yield { type: "text_delta", text: "finished" }; yield { type: "stop", reason: "end_turn" }; }
    } };
  const store = new SessionStore({ root: join(cwd, "logs") });
  controller.attach(createAgent({ provider, tools: builtinTools(), store, repoMap: false,
    systemPrompt: "fixture", permissions: new RulePolicy([], "ask"), onAsk: controller.ask }));
  const mounted = render(createElement(App, { controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  try {
    await writeFile(join(cwd, "target.txt"), "context\nold\ntail\n");
    const running = controller.submit("edit target");
    await waitForTuiState(controller, running, "actual write ask", state => state.pending?.req.tool === "edit_file");
    await vi.waitFor(() => expect(writes.join("")).toContain("proposed replacement excerpt"));
    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("context\nold\ntail\n");
    expect(writes.join("")).toContain("Declared permission:");
    controller.answerPermission("allow"); await running;
    await vi.waitFor(() => expect(writes.join("")).toContain("observed before/after"));
    expect(writes.join("")).toContain("@@ -1,3 +1,3 @@");
    expect(writes.join("")).toContain("-old"); expect(writes.join("")).toContain("+new");
    expect(writes.join("")).toContain(" context");
    expect(writes.join("")).not.toContain("\u001b[2J");
    const state = controller.snapshot();
    const event = (await store.readAll(state.sessionId!)).find(e => e.type === "tool.result" && e.id === "edit")!;
    const captured = renderChatEvent(event);
    await writeFile(join(cwd, "target.txt"), "external change");
    expect(renderChatEvent(event)).toBe(captured);
    expect(captured).not.toContain("external change");
  } finally { await controller.shutdown(); mounted.unmount(); await rm(cwd, { recursive: true, force: true }); }
});
