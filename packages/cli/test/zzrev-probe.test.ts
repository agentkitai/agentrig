import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent, defaultRules, RulePolicy, SessionStore,
  type ModelEvent, type ModelProvider,
} from "@agentkitai/agentrig-core";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.ts";

class FakeStdin extends EventEmitter {
  isTTY = true;
  private readonly chunks: string[] = [];
  setEncoding(): this { return this; }
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  read(): string | null { return this.chunks.shift() ?? null; }
  queue(text: string, chunk = 64): void {
    for (let i = 0; i < text.length; i += chunk) this.chunks.push(text.slice(i, i + chunk));
  }
  paste(text: string, chunk = 64): void { this.queue(text, chunk); this.emit("readable"); }
}
class Quiet implements ModelProvider {
  readonly id = "fake"; readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 };
  async *stream(): AsyncIterable<ModelEvent> { yield { type: "stop", reason: "end_turn" }; }
}
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "zzrev-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function mount(scrollback = 300) {
  let writes: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & Record<string, unknown>;
  (stdout as never as Record<string, unknown>)["columns"] = 80;
  (stdout as never as Record<string, unknown>)["rows"] = 30;
  (stdout as never as Record<string, unknown>)["isTTY"] = true;
  (stdout as never as Record<string, unknown>)["write"] = (s: string): boolean => { writes.push(s); return true; };
  const controller: TuiController = new TuiController({
    cwd: root,
    agent: createAgent({
      provider: new Quiet(), tools: [], permissions: new RulePolicy(defaultRules),
      systemPrompt: "test", store: new SessionStore({ root }),
      budget: { maxTurns: 4 }, maxTokensPerTurn: 100,
      onAsk: (req) => controller.ask(req),
    }),
  });
  for (let i = 0; i < scrollback; i += 1) controller.print(`tool read some/path/file-${i}.ts`, "event");
  const stdin = new FakeStdin();
  const instance = render(createElement(App, { controller }), {
    stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
  });
  return { stdin, controller, get writes(): string[] { return writes; },
    reset: (): void => { writes = []; }, stop: (): void => instance.unmount() };
}
const settle = (ms = 250): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/zzrev.txt";

describe("multi-line paste vs the no-writes-mid-paste invariant", () => {
  it("single-line control, exactly the shape the committed test uses", async () => {
    const h = mount();
    await settle();
    h.reset();
    for (let i = 0; i < 31; i += 1) {
      h.stdin.paste("x".repeat(64), 64);
      await new Promise((r) => setImmediate(r));
    }
    const during = h.writes.length;
    await settle(400);
    h.stop();
    appendFileSync(OUT, `single-line: writes DURING=${during}\n`);
    expect(during).toBe(0);
  }, 30_000);

  it("the same paste with ONE newline in it", async () => {
    const h = mount();
    await settle();
    h.reset();
    for (let i = 0; i < 31; i += 1) {
      h.stdin.paste(i === 10 ? `${"x".repeat(63)}\n` : "x".repeat(64), 64);
      await new Promise((r) => setImmediate(r));
    }
    const during = h.writes.length;
    const bytes = h.writes.reduce((n, s) => n + s.length, 0);
    const biggest = Math.max(0, ...h.writes.map((s) => s.length));
    await settle(600);
    h.stop();
    appendFileSync(OUT, `multi-line: writes DURING=${during} bytes=${bytes} biggest=${biggest}\n`);
    expect(during, "writes while the terminal was still pushing the paste").toBe(0);
  }, 30_000);
});
