import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SpendLedger } from "@agentkitai/agentrig-core";
import type { TuiController } from "../src/tui/controller.js";
const harness = vi.hoisted(() => ({ exercise: undefined as ((controller: TuiController) => Promise<void>) | undefined }));
// Only terminal mounting is replaced here; separate status-snapshot tests mount real Ink.
vi.mock("ink", async original => ({ ...await original<typeof import("ink")>(), render: (element: { props: { controller: TuiController } }) => ({
  unmount() {}, waitUntilExit: () => harness.exercise!(element.props.controller),
}) }));
import { startTui } from "../src/tui/start.js";
const roots: string[] = [];
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", tty);
  process.exitCode = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([{}, { yolo: true }, { dangerouslySkipPermissions: true }])("actual startup uses effective permission posture without model work (%j)", async flags => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-status-start-"))); roots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root); vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const read = vi.spyOn(SpendLedger.prototype, "report");
  harness.exercise = async controller => {
    const stop = controller.mountStatus();
    expect(controller.snapshot().statusDetails).toMatchObject({ posture: Object.keys(flags).length ? "yolo" : "ask", sandbox: "none", grants: 0 });
    expect(read).not.toHaveBeenCalled(); stop();
  };
  await startTui({ root: join(root, "logs"), provider: "anthropic", model: "fixture", repoMap: false, maxTurns: "5", maxTokensPerTurn: "100", ...flags });
});
it("actual non-TTY startup refuses before creating a status poller", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const read = vi.spyOn(SpendLedger.prototype, "report"); const interval = vi.spyOn(globalThis, "setInterval");
  await startTui({ root: "/unused", provider: "anthropic", model: "fixture" });
  expect(process.exitCode).toBe(1); expect(read).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
});
