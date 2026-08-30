import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.ts";

/**
 * That the frame CONTAINS what the controller said.
 *
 * Every other test of this component counts bytes: how many writes, how large, whether a
 * full-screen clear appears. All of them passed while the App had no subscription to the
 * controller at all — the TUI accepted input, ran the agent, wrote session logs, and displayed
 * none of it. A user saw their task vanish on enter with no echo, no status change and no
 * permission prompt, while the session on disk showed the model planning happily.
 *
 * Counting bytes cannot see that. These assert on content.
 */

const frame = (writes: string[]): string => writes.join("");

interface Harness {
  controller: TuiController;
  writes: string[];
  stop: () => void;
}

function mount(): Harness {
  const writes: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    isTTY: boolean;
    write: (s: string) => boolean;
  };
  stdout.columns = 158;
  stdout.rows = 52;
  stdout.isTTY = true;
  stdout.write = (s: string): boolean => {
    writes.push(s);
    return true;
  };

  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin["isTTY"] = true;
  stdin["setEncoding"] = () => stdin;
  stdin["setRawMode"] = () => stdin;
  stdin["ref"] = () => stdin;
  stdin["unref"] = () => stdin;
  stdin["read"] = () => null;

  const controller = new TuiController({
    cwd: process.cwd(),
    agent: {
      run: () => {
        throw new Error("this test never runs the agent");
      },
    } as never,
  });

  const instance = render(createElement(App, { controller }), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return { controller, writes, stop: () => instance.unmount() };
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 150));
};

describe("what the controller says reaches the screen", () => {
  it("shows a line the controller printed", async () => {
    const h = mount();
    await settle();
    h.controller.print("PRINTED-AFTER-MOUNT", "system");
    await settle();
    const out = frame(h.writes);
    h.stop();
    expect(out).toContain("PRINTED-AFTER-MOUNT");
  });

  it("shows a permission prompt when the agent asks for one", async () => {
    const h = mount();
    await settle();
    // nothing awaits this: the prompt is the point, not the answer
    void h.controller.ask({ tool: "bash", class: "exec" });
    await settle();
    const out = frame(h.writes);
    h.stop();
    // a user whose task is blocked on this and cannot see it has no way to know why nothing happens
    expect(out).toContain("bash");
    expect(out).toContain("allow");
  });

  it("shows the session id and status once a turn is under way", async () => {
    const h = mount();
    await settle();
    // drive the state the way `start()` does, without needing a provider
    (h.controller as unknown as { set: (p: Record<string, unknown>) => void }).set({
      status: "running",
      sessionId: "abc123",
    });
    await settle();
    const out = frame(h.writes);
    h.stop();
    expect(out).toContain("abc123");
    expect(out).toContain("running");
  });
});
