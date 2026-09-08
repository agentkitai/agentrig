import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { Checkpointer, git } from "../src/checkpointer.js";

const processMock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: processMock.execFile,
}));

let child: EventEmitter;
let complete: (error: Error | null, stdout: string, stderr: string) => void;
beforeEach(() => {
  child = new EventEmitter();
  processMock.execFile.mockReset().mockImplementation((_file, _args, _options, callback) => {
    complete = callback;
    return child;
  });
});

it.each(["abort", "spawn", "success"])("joins process close after the %s callback", async kind => {
  let settled = false;
  const work = git("fixture", ["status"]).then(
    value => { settled = true; return value; },
    error => { settled = true; return error; },
  );
  const error = kind === "success" ? null : Object.assign(new Error(kind), {
    code: kind === "abort" ? "ABORT_ERR" : "ENOENT",
  });
  complete(error, "output", "diagnostic");
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", kind === "success" ? 0 : null);
  const result = await work;
  if (error) {
    expect(result).toBe(error);
    expect(result).toMatchObject({ stdout: "output", stderr: "diagnostic" });
  } else expect(result).toEqual({ stdout: "output", stderr: "diagnostic" });
});

it("retains the checkpoint attempt through cancelled process cleanup", async () => {
  const cp = new Checkpointer();
  const controller = new AbortController();
  const work = cp.handler({ point: "pre_tool", sessionId: "closing", cwd: "fixture", turn: 1,
    signal: controller.signal, emitCheckpoint: async () => {} }).catch(error => error);
  controller.abort();
  complete(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }), "", "");
  // Flush the rejected-handler continuation too: it must not discard ownership before close.
  await new Promise<void>(resolve => setImmediate(resolve));
  let released = false;
  const cleanup = cp.endSession("closing").then(() => { released = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(released).toBe(false);
  child.emit("close", null);
  expect(await work).toMatchObject({ code: "ABORT_ERR" });
  await cleanup;
  expect(released).toBe(true);
});
