import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelEvent } from "@agentkitai/agentrig-core";
import type { SuperviseOptions } from "@agentkitai/agentrig-supervisor";
import type { TuiController } from "../src/tui/controller.js";
const harness = vi.hoisted(() => ({ options: [] as SuperviseOptions[],
  exercise: undefined as ((controller: TuiController) => Promise<void>) | undefined }));
vi.mock("ink", async original => ({ ...await original<typeof import("ink")>(), render: (element: { props: { controller: TuiController } }) => ({
  unmount() {}, waitUntilExit: () => harness.exercise!(element.props.controller),
}) }));
vi.mock("@agentkitai/agentrig-supervisor", async original => {
  const actual = await original<typeof import("@agentkitai/agentrig-supervisor")>();
  return { ...actual, supervise: (...args: Parameters<typeof actual.supervise>) => {
    harness.options.push(args[1]!); return actual.supervise(...args);
  } };
});
vi.mock("../src/agent-builder.js", async original => {
  const actual = await original<typeof import("../src/agent-builder.js")>();
  return { ...actual, buildAgent: async (...args: Parameters<typeof actual.buildAgent>) => {
    const built = await actual.buildAgent(...args);
    vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
      yield { type: "text", text: "fixture complete" }; yield { type: "stop", reason: "end_turn" };
    });
    return built;
  } };
});
import { startTui } from "../src/tui/start.js";
import { supervisorOptions } from "../src/run.js";
const roots: string[] = [];
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); harness.options.length = 0;
  if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", tty);
  process.exitCode = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([{}, { yolo: true }, { dangerouslySkipPermissions: true }])("actual TUI retains supervision but offers human escalation only when attended (%j)", async flags => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "unattended-supervisor-"))); roots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root); vi.stubEnv("ANTHROPIC_API_KEY", "inert-fixture");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  harness.exercise = async controller => { await controller.submit("Finish the fixture."); };
  await startTui({ root: join(root, "logs"), provider: "anthropic", model: "fixture", repoMap: false,
    maxTurns: "5", maxTokensPerTurn: "100", supervise: true, supervisorAbort: true, ...flags });
  expect(harness.options).toHaveLength(1);
  const options = harness.options[0]!;
  expect(typeof options.onEscalate).toBe(Object.keys(flags).length ? "undefined" : "function");
  expect(options.capabilities).toEqual({ abort: true });
  expect(options.budget).toMatchObject({ maxTurns: 5 });
});

it.each([{ yolo: true }, { dangerouslySkipPermissions: true }])("shared adapter drops human capability but preserves reviewer, drift, errors and abort (%j)", flags => {
  const onEscalate = vi.fn(), onError = vi.fn();
  const options = supervisorOptions({ opts: { ...flags, supervisorAbort: true, supervisorReview: true, driftScope: ["src"] },
    task: "fixture", budget: { maxTurns: 20 }, memoryIndex: "", provider: { id: "fixture", model: "fixture" } as never,
    soft: 0.8, turnsRemaining: 3, onEscalate, onError });
  expect(options).not.toHaveProperty("onEscalate");
  expect(onEscalate).not.toHaveBeenCalled();
  expect(options.capabilities).toEqual({ abort: true });
  expect(options.reviewer).toBeDefined(); expect(options.grader).toBeDefined();
  expect(options.drift).toMatchObject({ scope: ["src"] }); expect(options.onError).toBe(onError);
});
