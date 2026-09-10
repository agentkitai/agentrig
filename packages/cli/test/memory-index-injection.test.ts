import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessEvent, ModelEvent } from "@agentkitai/agentrig-core";
import { FileMemoryStore, indexInjection, ingestOnSessionEnd } from "@agentkitai/agentrig-memory";
import { buildAgent, type AgentBuildOptions } from "../src/agent-builder.ts";
import { loadRunConfig, parseConfigText } from "../src/config.ts";
import { buildProgram } from "../src/program.ts";

/**
 * R17f: recommended CLI configuration disables automatic index injection without touching
 * explicit retrieval or session-end ingestion. Direct SDK unspecified remains ON for compatibility.
 * Nothing reaches the network: the main and
 * memory role providers are both replaced with fixtures before a session runs.
 */

vi.mock("@agentkitai/agentrig-memory", async original => {
  const actual = await original<typeof import("@agentkitai/agentrig-memory")>();
  return { ...actual, indexInjection: vi.fn(actual.indexInjection), ingestOnSessionEnd: vi.fn(actual.ingestOnSessionEnd) };
});

vi.setConfig({ testTimeout: 30_000 });

const INDEX_HEADER = "## Project memory (index)";
let root: string;
let memoryRoot: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-r17f-injection-")));
  memoryRoot = join(root, ".agentrig");
  const wiki = new FileMemoryStore({ root: join(memoryRoot, "wiki") });
  await wiki.init();
  await wiki.write("concepts/retry-policy.md", {
    path: "concepts/retry-policy.md",
    body: "- [observed] Retries apply per request, not per batch (session:8f2a)",
    frontmatter: { type: "concept", slug: "retry-policy", aliases: [], sources: ["session:8f2a"], updated: "2026-09-09", confidence: "high" },
  });
  await wiki.upsertIndex({ slug: "retry-policy", path: "concepts/retry-policy.md", type: "concept", status: "active",
    summary: "how retries are scoped" });
  vi.mocked(indexInjection).mockClear();
  vi.mocked(ingestOnSessionEnd).mockClear();
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-not-live");
  vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** One built agent whose two live roles are fixtures, plus the system prompts it actually sent. */
async function build(overrides: Partial<AgentBuildOptions> = {}, captureWork = false) {
  const built = await buildAgent({
    root: join(root, "sessions"), provider: "anthropic", model: "fixture", sandbox: "none",
    yolo: true, repoMap: false, memory: memoryRoot, ingestOnEnd: true,
    maxTurns: "4", maxTokensPerTurn: "1000", ...overrides,
  } as AgentBuildOptions);
  const systems: string[] = [];
  // The main and memory roles resolve to the same default entry here, so one fixture serves both.
  // Only the agent's own requests carry the tool catalogue; the session-end ingest call has none.
  const stream = async function* (request: { system: string; tools: unknown[] }): AsyncIterable<ModelEvent> {
    if (request.tools.length === 0) {
      yield { type: "text_delta", text: JSON.stringify({ facts: [{ pageType: "concept", slug: "retry", tag: "observed", text: "Retry each request" }] }) };
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    systems.push(request.system);
    if (captureWork && systems.length === 1) {
      yield { type: "tool_use", id: "capture-write", name: "write_file", input: { path: "capture.txt", content: "durable work\n" } };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "usage", usage: { input: 10, output: 5 } };
    yield { type: "stop", reason: "end_turn" };
  };
  built.provider.stream = stream as typeof built.provider.stream;
  built.providers.memory.stream = stream as typeof built.provider.stream;
  return { built, systems };
}

async function runOnce(built: Awaited<ReturnType<typeof build>>["built"], task = "say hi"): Promise<HarnessEvent[]> {
  const session = built.agent.run(task, { cwd: root });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  await session.done;
  return events;
}

const memoryToolNames = (built: Awaited<ReturnType<typeof build>>["built"]): string[] =>
  built.tools.map(tool => tool.name).filter(name => name.startsWith("memory_")).sort();

it.each([
  ["unspecified (current and legacy behaviour)", {}],
  ["explicitly true", { memoryIndexInjection: true }],
])("injects the memory index when memoryIndexInjection is %s", async (_label, overrides) => {
  const { built, systems } = await build(overrides);
  await runOnce(built);
  expect(built.memoryIndex).toContain(INDEX_HEADER);
  expect(systems).toHaveLength(1);
  expect(systems[0]).toContain(INDEX_HEADER);
  expect(systems[0]).toContain("concepts/retry-policy.md");
  expect(indexInjection).toHaveBeenCalledTimes(1);
});

it("drops the injected index when memoryIndexInjection is false, and nothing else", async () => {
  const on = await build();
  const off = await build({ memoryIndexInjection: false }, true);
  const events = await runOnce(off.built, "Write capture.txt with durable work, then finish");
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.result", id: "capture-write", permission: "write", ok: true }));

  // the prompt: no index block at all, not an empty or renamed one
  expect(off.built.memoryIndex).toBe("");
  expect(off.systems).toHaveLength(2);
  for (const system of off.systems) {
    expect(system).not.toContain(INDEX_HEADER);
    expect(system).not.toContain("concepts/retry-policy.md");
  }
  // and the index is not even read, so a large wiki costs nothing here
  expect(vi.mocked(indexInjection).mock.calls).toHaveLength(1); // the `on` build only

  // retrieval is untouched: the same tools, still allowed by the same startup rules
  expect(memoryToolNames(off.built)).toEqual(memoryToolNames(on.built));
  expect(memoryToolNames(off.built)).toEqual(expect.arrayContaining(["memory_read", "memory_search"]));
  for (const tool of ["memory_read", "memory_search"]) {
    expect(await off.built.permissions.decide({ tool, input: {}, class: "read", cwd: root })).toBe("allow");
  }
  expect(off.built.memoryStore).toBeDefined();

  // ingestion is untouched: the session-end hook is registered on the same directory and ran
  expect(ingestOnSessionEnd).toHaveBeenCalledTimes(2);
  expect(vi.mocked(ingestOnSessionEnd).mock.calls.at(-1)?.[0]).toMatchObject({ dir: memoryRoot, sessionDir: join(root, "sessions") });
  expect(await readdir(join(memoryRoot, "wiki", "sources"))).not.toHaveLength(0);
});

it("rejects a non-boolean memoryIndexInjection at the config boundary", () => {
  expect(parseConfigText("fixture", JSON.stringify({ memoryIndexInjection: false }))).toEqual({ memoryIndexInjection: false });
  expect(parseConfigText("fixture", JSON.stringify({ memoryIndexInjection: true }))).toEqual({ memoryIndexInjection: true });
  for (const value of ["false", "off", 0, 1, null, {}]) {
    expect(() => parseConfigText("fixture", JSON.stringify({ memoryIndexInjection: value })))
      .toThrow("invalid config fixture at memoryIndexInjection: Expected boolean");
  }
  expect(() => parseConfigText("fixture", JSON.stringify({ memoryIndexInjectionn: false }))).toThrow("Unrecognized setting");
});

it("defaults recommended injection off and preserves explicit project/profile opt-in", async () => {
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(join(cwd, ".agentrig"), { recursive: true }), mkdir(join(home, ".agentrig"), { recursive: true })]);
  await writeFile(join(home, ".agentrig", "trust.json"), JSON.stringify({ projects: { [cwd]: true } }), "utf8");
  const runCommand = () => buildProgram().commands.find(command => command.name() === "run")!;

  // No config: the measured recommended policy disables automatic index injection.
  const bare = await loadRunConfig(runCommand(), {}, { cwd, home, env: {}, interactive: false });
  expect(bare.memoryIndexInjection).toBe(false);
  const defaultBuild = await build(bare as Partial<AgentBuildOptions>);
  await runOnce(defaultBuild.built);
  expect(defaultBuild.systems[0]).not.toContain(INDEX_HEADER);
  expect(memoryToolNames(defaultBuild.built)).toEqual(expect.arrayContaining(["memory_read", "memory_search"]));

  await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ memoryIndexInjection: false }), "utf8");
  const resolved = await loadRunConfig(runCommand(), {}, { cwd, home, env: {}, interactive: false });
  expect(resolved.memoryIndexInjection).toBe(false);
  // the resolved record is what the entry points hand to buildAgent, unmodified
  const { built, systems } = await build(resolved as Partial<AgentBuildOptions>);
  await runOnce(built);
  expect(built.memoryIndex).toBe("");
  expect(systems[0]).not.toContain(INDEX_HEADER);

  await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ memoryIndexInjection: true }), "utf8");
  const optIn = await loadRunConfig(runCommand(), {}, { cwd, home, env: {}, interactive: false });
  expect(optIn.memoryIndexInjection).toBe(true);
  const enabled = await build(optIn as Partial<AgentBuildOptions>);
  await runOnce(enabled.built);
  expect(enabled.systems[0]).toContain(INDEX_HEADER);

  // A selected profile can opt back in without changing the bare recommended default.
  await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ profiles: { recall: { memoryIndexInjection: true } } }), "utf8");
  const command = runCommand();
  expect((await loadRunConfig(command, { profile: "recall" }, { cwd, home, env: {}, interactive: false })).memoryIndexInjection).toBe(true);
  expect((await loadRunConfig(command, {}, { cwd, home, env: {}, interactive: false })).memoryIndexInjection).toBe(false);
});

it("keeps the key out of the CLI surface", () => {
  const options = buildProgram().commands.flatMap(command => command.options.map(option => option.long ?? ""));
  expect(options).not.toContain("--memory-index-injection");
  expect(options).not.toContain("--no-memory-index-injection");
});
