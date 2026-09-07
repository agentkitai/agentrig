import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TuiController } from "../src/tui/controller.js";
import { waitForTuiState } from "./tui-readiness.js";

const harness = vi.hoisted(() => ({ home: "", calls: 0, exercise: undefined as undefined | ((controller: TuiController, frames: string[]) => Promise<void>) }));
// Real startup, builder, controller, core, diagnostics, Git and Ink; only IO/provider are fixtures.
vi.mock("ink", async importOriginal => {
  const original = await importOriginal<typeof import("ink")>();
  const { EventEmitter } = await import("node:events");
  return { ...original, render: (element: Parameters<typeof original.render>[0] & { props: { controller: TuiController } }) => {
    class Input extends EventEmitter { isTTY = true; setEncoding() { return this; } setRawMode() { return this; } ref() { return this; } unref() { return this; } read() { return null; } }
    const frames: string[] = [];
    const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 24, isTTY: true, write(text: string) { frames.push(text); stdout.emit("frame"); return true; } });
    const ink = original.render(element, { stdin: new Input() as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
    const c = element.props.controller;
    const source = { snapshot: () => c.snapshot(), subscribe(listener: (state: ReturnType<TuiController["snapshot"]>) => void) {
      const changed = () => listener(c.snapshot()); stdout.on("frame", changed); changed(); return () => { stdout.off("frame", changed); };
    } };
    const done = (async () => {
      await waitForTuiState(source, new Promise(() => {}), "mounted startup frame", () => frames.join("").includes("type a task"));
      await harness.exercise!(c, frames);
      await waitForTuiState(source, new Promise(() => {}), "manual output frame", () => frames.join("").includes("Manifest delta"));
    })().finally(() => ink.unmount());
    return { unmount: () => ink.unmount(), waitUntilExit: () => done };
  } };
});
vi.mock("../src/agent-builder.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/agent-builder.js")>();
  return { ...original, buildAgent: async (...args: Parameters<typeof original.buildAgent>) => {
    const built = await original.buildAgent(...args);
    vi.spyOn(built.provider, "stream").mockImplementation(async function* (request) {
      harness.calls++;
      yield { type: "text_delta", text: request.system.startsWith("You compress") ? "Condensed fixture." : "Long answer. ".repeat(100) };
      yield { type: "stop", reason: "end_turn" };
    });
    return built;
  } };
});
vi.mock("../src/doctor.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/doctor.js")>();
  return { ...original, diagnose: (options: Parameters<typeof original.diagnose>[0]) => original.diagnose({ ...options, home: harness.home, env: {} }) };
});
import { startTui } from "../src/tui/start.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); harness.calls = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("production startTui wires all four manual commands without a diagnostic/diff model call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-manual-start-")); roots.push(cwd); harness.home = cwd;
  const git = (args: string[]) => promisify(execFile)("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.autocrlf=false", ...args], { cwd });
  await git(["init", "-q"]); await writeFile(join(cwd, "a.txt"), "before\n"); await git(["add", "a.txt"]); await git(["commit", "-qm", "fixture"]);
  await writeFile(join(cwd, "a.txt"), "after\n");
  vi.spyOn(process, "cwd").mockReturnValue(cwd); vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture");
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"); Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  harness.exercise = async c => {
    for (let turn = 0; turn < 7; turn++) await c.submit(`task ${turn}: ${"context ".repeat(100)}`);
    const parent = c.snapshot().sessionId;
    await c.submit("/doctor"); await c.submit("/diff");
    expect(harness.calls).toBe(7);
    expect(c.snapshot().lines.some(line => line.text.includes("no provider probe"))).toBe(true);
    expect(c.snapshot().lines.some(line => line.text.includes("+after"))).toBe(true);
    await c.submit("/compact"); expect(harness.calls).toBe(8); expect(c.snapshot().sessionId).not.toBe(parent);
    await c.submit("/clear"); expect(c.snapshot().sessionId).toBeNull(); expect(harness.calls).toBe(8);
  };
  try { await startTui({ root: join(cwd, "logs"), provider: "anthropic", model: "fake", repoMap: false, maxTurns: "20", maxTokensPerTurn: "100" }); }
  finally { if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", tty); }
}, 30_000);
