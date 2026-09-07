import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TuiController } from "../src/tui/controller.js";
const harness = vi.hoisted(() => ({ builds: 0, mounts: 0,
  afterBuild: undefined as undefined | (() => void),
  exercise: undefined as undefined | ((c: TuiController, send: (s: string) => void, writes: string[]) => Promise<void>) }));
vi.mock("../src/agent-builder.js", async original => {
  const module = await original<typeof import("../src/agent-builder.js")>();
  return { ...module, buildAgent: async (...args: Parameters<typeof module.buildAgent>) => {
    harness.builds++; const built = await module.buildAgent(...args); harness.afterBuild?.(); return built;
  } };
});
vi.mock("ink", async original => {
  const module = await original<typeof import("ink")>();
  const { EventEmitter } = await import("node:events");
  return { ...module, render: (element: Parameters<typeof module.render>[0] & { props: { controller: TuiController } }) => {
    harness.mounts++;
    class Input extends EventEmitter {
      isTTY = true; chunks: string[] = [];
      setEncoding() { return this; } setRawMode() { return this; }
      ref() { return this; } unref() { return this; }
      read() { return this.chunks.shift() ?? null; }
      send(s: string) { this.chunks.push(s); this.emit("readable"); }
    }
    const input = new Input(), writes: string[] = [];
    const output = Object.assign(new EventEmitter(), { columns: 120, rows: 40, isTTY: true,
      write(s: string) { writes.push(s); return true; } });
    const ink = module.render(element, { stdin: input as never, stdout: output as never, patchConsole: false, exitOnCtrlC: false });
    const done = (async () => {
      await vi.waitFor(() => expect(writes.join("")).toContain("type a task"));
      await harness.exercise!(element.props.controller, s => input.send(s), writes);
    })().finally(() => ink.unmount());
    return { unmount: () => ink.unmount(), waitUntilExit: () => done };
  } };
});
import { loadRunConfig, parseConfigText, resolveConfig } from "../src/config.js";
import { buildProgram } from "../src/program.js";
import { startTui, type TuiOptions } from "../src/tui/start.js";
const roots: string[] = [];
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); harness.builds = 0; harness.mounts = 0; harness.afterBuild = undefined;
  if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", tty);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(["ordinary", "protocol"])("trusted user config reaches actual startup and Ink permission keys (%s)", async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-settings-start-"))); roots.push(root);
  const taskHome = await realpath(await mkdtemp(join(tmpdir(), "agentrig-settings-user-"))); roots.push(taskHome);
  await mkdir(join(taskHome, ".agentrig"), { recursive: true });
  const tui = { theme: "light", keybindings: { permission: { allowOnce: "j", denyOnce: "k" } } };
  await writeFile(join(taskHome, ".agentrig/config.json"), JSON.stringify({ tui }));
  vi.spyOn(process, "cwd").mockReturnValue(root); vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const program = buildProgram(); const cmd = program.commands.find(c => c.name() === "tui")!;
  const options = await loadRunConfig(cmd, { root: join(root, "logs"), provider: "anthropic", model: "fake", repoMap: false, maxTurns: "5", maxTokensPerTurn: "100" },
    { cwd: root, home: taskHome, env: {}, interactive: false });
  expect(options.tui).toMatchObject(tui);
  // Startup captures a deep validated copy before asynchronous construction.
  harness.afterBuild = () => { (options.tui as typeof tui).keybindings.permission.allowOnce = "x"; };
  const fetch = vi.spyOn(globalThis, "fetch");
  harness.exercise = async (c, send, writes) => {
    const answer = c.ask({ tool: "fixture_read", class: "read", cwd: root, input: {} });
    await vi.waitFor(() => expect(writes.join("")).toContain("j = allow once"));
    send(mode === "protocol" ? "\u001b[201~j" : "j");
    expect(await answer).toBe("allow");
    expect(c.permissionGrants.list()).toEqual([]);
  };
  await startTui(options as TuiOptions);
  expect(harness.builds).toBe(1); expect(harness.mounts).toBe(1); expect(fetch).not.toHaveBeenCalled();
}, 15_000);
it("invalid direct startup settings fail before provider construction or mounting", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  await expect(startTui({ root: "/unused", tui: { keybindings: { permission: { allowOnce: "n" } } } })).rejects.toThrow();
  expect(harness.builds).toBe(0); expect(harness.mounts).toBe(0);
});
it("configuration rejects arbitrary key sequences and unknown nested fields without echoing values", () => {
  for (const tui of [{ theme: "CANARY" }, { keybindings: { abort: "CANARY" } },
    { keybindings: { permission: { allowOnce: "\u001bCANARY" } } }, { theme: "light", editor: "CANARY" }]) {
    expect(() => parseConfigText("fixture", JSON.stringify({ tui }))).toThrow();
    try { parseConfigText("fixture", JSON.stringify({ tui })); } catch (error) { expect(String(error)).not.toContain("CANARY"); }
  }
});
it("tui settings use the existing whole-object precedence, not cross-layer keymap merging", () => {
  const user = parseConfigText("user", JSON.stringify({ tui: { theme: "light", keybindings: { permission: { allowOnce: "j" } } } }));
  const project = parseConfigText("project", JSON.stringify({ tui: { theme: "dark" } }));
  expect(resolveConfig({ defaults: {}, user, project, env: {}, cli: {} }).tui).toEqual({ theme: "dark" });
});
