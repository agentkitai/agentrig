import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ownedProcess } from "../src/owned-process.ts";
import { createAgent, SessionStore, type ModelEvent } from "@agentkitai/agentrig-core";
import { FileMemoryStore, memoryTools } from "@agentkitai/agentrig-memory";
import { attach, signal, supervise } from "@agentkitai/agentrig-supervisor";
import { buildAgent } from "../src/agent-builder.ts";
import { TuiController } from "../src/tui/controller.ts";

/**
 * R17e's acceptance, run end to end on the fake provider: a fixture intervention appears as a
 * transcript line, `/why` names it, and a memory recall shows the page and the claim rather than a
 * count. Nothing here reaches the network and nothing spends model tokens.
 */

vi.setConfig({ testTimeout: 30_000 });
let root: string;
let memoryRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-r17e-cli-"));
  memoryRoot = join(root, ".agentrig");
  await writeFile(join(root, "spec.md"), "the spec\n");
  const wiki = new FileMemoryStore({ root: join(memoryRoot, "wiki") });
  await wiki.init();
  await wiki.write("concepts/retry-policy.md", {
    path: "concepts/retry-policy.md",
    body: "- [observed] Retries apply per request, not per batch (session:8f2a)",
    frontmatter: { type: "concept", slug: "retry-policy", aliases: ["retries"], sources: ["session:8f2a"], updated: "2026-09-08", confidence: "high" },
  });
  await wiki.upsertIndex({ slug: "retry-policy", path: "concepts/retry-policy.md", type: "concept", status: "active",
    summary: "how retries are scoped" });
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-not-live");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

/** A session that recalls memory once and then repeats one identical read until it is steered. */
async function build(script: "recall-then-loop" | "quiet") {
  const built = await buildAgent({
    root: join(root, "sessions"), provider: "anthropic", model: "fixture", sandbox: "none",
    yolo: true, repoMap: false, memory: memoryRoot, maxTurns: "12", maxTokensPerTurn: "1000",
  });
  let turn = 0;
  built.provider.stream = async function* (request): AsyncIterable<ModelEvent> {
    turn += 1;
    // Stops on the turn that carries the supervisor's guidance, which is the turn `/why` explains:
    // the agent is steered, reads the guidance in its own conversation, and finishes.
    const steered = JSON.stringify(request.messages).includes("[supervisor:");
    if (script === "quiet" || steered || turn > 8) {
      yield { type: "text_delta", text: "done" };
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    if (turn === 1) yield { type: "tool_use", id: "m1", name: "memory_search", input: { query: "retry" } };
    else yield { type: "tool_use", id: `r${turn}`, name: "read_file", input: { path: join(root, "spec.md") } };
    yield { type: "usage", usage: { input: 10, output: 5 } };
    yield { type: "stop", reason: "tool_use" };
  };
  return built;
}

const transcript = (controller: TuiController): string =>
  controller.state.lines.map((line) => line.text).join("\n");

it("shows the memory replacement a real post_tool hook actually sends to the provider", async () => {
  const requests: string[] = [];
  const agent = createAgent({
    provider: { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 32000 },
      async *stream(request): AsyncIterable<ModelEvent> {
        requests.push(JSON.stringify(request.messages));
        if (requests.length === 1) {
          yield { type: "tool_use", id: "recall", name: "memory_read", input: { path: "concepts/retry-policy.md" } };
          yield { type: "stop", reason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "stop", reason: "end_turn" };
        }
      } },
    store: new SessionStore({ root: join(root, "hook-sessions") }),
    tools: memoryTools({ store: new FileMemoryStore({ root: join(memoryRoot, "wiki") }) }),
    permissions: { decide: async () => "allow" }, systemPrompt: "test", repoMap: false,
    hooks: [{ point: "post_tool", handler: async () => ({ action: "modify", patch: "Never retry: injected by the fixture hook" }) }],
  });
  const controller = new TuiController({ agent, cwd: root });
  try {
    await controller.submit("read the retry policy");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Never retry: injected by the fixture hook");
    expect(transcript(controller)).toContain("Never retry: injected by the fixture hook");
    expect(transcript(controller)).toContain("not a verified memory claim");
  } finally { await controller.shutdown(); }
});

it("renders the intervention, its notice and its cost, and explains it with /why", async () => {
  const built = await build("recall-then-loop");
  const controller = new TuiController({
    agent: built.agent, cwd: root, supervised: true, memoryIndex: built.memoryIndex,
    onSession: (session) => supervise(session, { loop: { repeats: 2 }, ladder: { ladder: ["inject_guidance"], cooldownTurns: 1 } }),
  });
  await controller.submit("find the retry policy and read the spec");
  const text = transcript(controller);

  // the intervention itself: what it noticed and what it decided, on one line
  expect(text).toMatch(/⚠ supervisor: noticed loop \(\d\.\d\d\)[^\n]*→ inject_guidance/);
  // and what applying it did, with the only cost claims the harness can stand behind
  expect(text).toContain("↳ inject_guidance queued");
  expect(text).toContain("no model call");
  expect(text).toMatch(/\+\d+ B of prompt \(~\d+ est\. tokens, not billed tokens\)/);
  expect(text).not.toContain("billed tokens:");

  // the recall: page and claim, not a result count
  expect(text).toContain("✻ memory recall (memory_search) \"retry\"");
  expect(text).toContain("concepts/retry-policy.md");
  expect(text).toContain("Retries apply per request, not per batch");
  // and the automatic injection announces itself, with no tool call behind it
  expect(text).toMatch(/✻ memory in the prompt: index injected — \d+ B/);

  await controller.submit("/why");
  const why = controller.state.lines.at(-1)!.text;
  expect(why).toMatch(/^why — turn \d+ of session /);
  expect(why).toContain("Injected guidance (1)");
  expect(why).toContain("the supervisor injected it");
  expect(why).toContain("decision: inject_guidance");
  expect(why).toContain("noticed: loop");
  expect(why).toContain("outcome: queued");
  expect(why).toContain("cost: no model call");
  expect(why).toContain("[supervisor: loop]");
  // memory's automatic block is separated from memory recalls carried as tool results
  expect(why).toContain("memory index —");
  expect(why).toContain("content verified against this request's hash");
  expect(why).toMatch(/Memory recalls carried in this request's history \(1 tool result/);
  expect(why).toContain("memory_search:m1");
  await controller.shutdown();
});

it("says plainly when nothing was injected, and forgets the previous conversation at /new", async () => {
  const built = await build("quiet");
  const controller = new TuiController({ agent: built.agent, cwd: root, memoryIndex: built.memoryIndex });
  await controller.submit("just answer");

  await controller.submit("/why");
  const why = controller.state.lines.at(-1)!.text;
  expect(why).toContain("Injected guidance: none.");
  expect(why).toContain("Nothing was added to this turn's conversation");
  // the automatic memory context is still declared: silence about guidance is not silence about the prompt
  expect(why).toContain("memory index —");
  expect(why).toContain("Memory recalls carried in this request's history: none.");

  await controller.submit("/new");
  await controller.submit("/why");
  expect(controller.state.lines.at(-1)!.text).toContain("no turn has run in this conversation yet");
  await controller.shutdown();
});

it("never reports guidance the session ended before delivering as injected", async () => {
  const built = await buildAgent({
    root: join(root, "sessions"), provider: "anthropic", model: "fixture", sandbox: "none",
    yolo: true, repoMap: false, memory: memoryRoot, maxTurns: "1", maxTokensPerTurn: "1000",
  });
  built.provider.stream = async function* (): AsyncIterable<ModelEvent> {
    yield { type: "tool_use", id: "r1", name: "read_file", input: { path: join(root, "spec.md") } };
    yield { type: "usage", usage: { input: 10, output: 5 } };
    yield { type: "stop", reason: "tool_use" };
  };
  let fired = false;
  const controller = new TuiController({
    agent: built.agent, cwd: root, supervised: true, memoryIndex: built.memoryIndex,
    // Core drains queued steers immediately BEFORE `turn.start`, so guidance decided in response to
    // that event can only ride the next turn — and this session has no next turn.
    onSession: (session) => attach(session, {
      detectors: [{ id: "late", observe: (event) => (fired || event.type !== "turn.start" ? null
        : ((fired = true), signal("stall", 0.9, ["nothing changed"], [0, event.seq]))) }],
      policy: { decide: () => [{ type: "inject_guidance", message: "[supervisor: stall] say what you are stuck on" }] },
    }),
  });
  await controller.submit("read the spec");

  await controller.submit("/why");
  const why = controller.state.lines.at(-1)!.text;
  expect(why).toContain("Injected guidance: none.");
  expect(why).toMatch(/Never delivered \(1\) — the session ended first/);
  expect(why).toContain("supervisor: [supervisor: stall] say what you are stuck on");
  // and the decision is still on record as a decision, with its own outcome line in the transcript
  expect(transcript(controller)).toContain("↳ inject_guidance queued");
  await controller.shutdown();
});

it("shows the recall and the injected index on the headless run surface too", async () => {
  await writeFile(join(memoryRoot, "config.json"), JSON.stringify({ ingestOnEnd: false, dreamOnEnd: false }));
  await mkdir(join(root, "home"), { recursive: true });
  let turn = 0;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const delta = turn++ === 0
      ? { tool_calls: [{ index: 0, id: "m1", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "retry" }) } }] }
      : { content: "retries are per request" };
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: turn === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture address");
  try {
    const output = await ownedProcess(process.execPath, [
      fileURLToPath(new URL("../dist/index.js", import.meta.url)), "run", "what is the retry policy?",
      "--headless", "--trust", "--provider", "openai", "--model", "fixture",
      "--base-url", `http://127.0.0.1:${address.port}/v1`, "--root", join(root, "sessions"),
      "--max-turns", "4", "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery",
    ], {
      cwd: root,
      env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), OPENAI_API_KEY: "fixture-not-a-secret" },
      signal: new AbortController().signal, timeoutMs: 20_000, maxBytes: 262_144,
      errorMessage: "headless visibility fixture failed",
    });
    expect(output).toMatch(/✻ memory in the prompt: index injected — \d+ B/);
    expect(output).toContain('✻ memory recall (memory_search) "retry"');
    expect(output).toMatch(/concepts\/retry-policy\.md \[(index|bm25|both)\]/);
    expect(output).toContain("Retries apply per request, not per batch");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
