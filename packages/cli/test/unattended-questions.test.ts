import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AnthropicProvider, messagesFromEvents, SessionStore, type HarnessEvent, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";
import { questionPolicy } from "../src/question-policy.ts";
import { runCommand } from "../src/run.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const question = { prompt: "Choose format", options: ["Text", "JSON"] };

it.each(["first-option", "file", "missing", "human-source"] as const)("unattended %s answer policy is distinct from a human callback", async mode => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-unattended-questions-")); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  const answers = join(root, "answers.json");
  await writeFile(answers, JSON.stringify({ version: 1, answers: [{ question, answer: { option: 1 } }] }));
  const onQuestion = vi.fn(async () => ({ source: "human" as const, answer: { option: 0 } }));
  const automated = mode === "human-source" ? async () => ({ source: "human" as const, answer: { option: 0 } }) : await questionPolicy(mode === "file" ? `file:${answers}` : mode === "missing" ? "fail" : mode);
  const built = await buildAgent({ root: join(root, "sessions"), provider: "anthropic", model: "fixture", yolo: true,
    sandbox: "none", repoMap: false, subagents: true, subagentMaxTurns: "3", maxTurns: "4", maxTokensPerTurn: "1000",
    skillDiscovery: false, extensionDiscovery: false, packages: false, diagnostics: [],
  }, { onQuestion, onUnattendedQuestion: automated });
  let parent = 0, child = 0;
  const stream = async function* (request: ModelRequest): AsyncIterable<ModelEvent> {
    const isChild = request.system.includes("You are a subagent.");
    const turn = isChild ? child++ : parent++;
    if (turn === 0) yield { type: "tool_use", id: "ask", name: "ask_user", input: question };
    else if (!isChild && turn === 1) yield { type: "tool_use", id: "child", name: "subagent", input: { task: "Ask which format." } };
    yield { type: "stop", reason: turn === 0 || (!isChild && turn === 1) ? "tool_use" : "end_turn" };
  };
  built.provider.stream = stream; built.providers.subagents.stream = stream;
  const session = built.agent.run("Choose format then delegate a format question", { cwd: root });
  const success = mode === "first-option" || mode === "file";
  expect((await session.done).reason).toBe(success ? "done" : "error");
  // Only the explicit unattended policy may run. A falsely human-labelled policy is rejected.
  expect(onQuestion).not.toHaveBeenCalled();
  const store = new SessionStore({ root: join(root, "sessions") });
  const events = await store.readAll(session.id);
  if (!success) {
    expect(parent).toBe(1); expect(child).toBe(0);
    expect(events.find(event => event.type === "question.answered")).toMatchObject({ outcome: "unavailable" });
    return;
  }
  const spawned = events.find(event => event.type === "subagent.spawn")!;
  for (const log of [events, await store.readAll(spawned.id)]) {
    expect(log.find(event => event.type === "question.answered")).toMatchObject({ outcome: "answered", reply: { source: mode } });
    expect(messagesFromEvents(log).flatMap(message => message.content).find(block => block.type === "tool_result" && block.toolUseId === "ask"))
      .toMatchObject({ trust: "external" });
  }
});

it.each(["first-option", "file", "fail"])("actual headless run wires --answer-policy %s under YOLO", async mode => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-unattended-run-question-")); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  const answers = join(root, "answers.json");
  await writeFile(answers, JSON.stringify({ version: 1, answers: [{ question, answer: { option: 1 } }] }));
  let calls = 0;
  vi.spyOn(AnthropicProvider.prototype, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    if (calls++ === 0) { yield { type: "tool_use", id: "ask", name: "ask_user", input: question }; yield { type: "stop", reason: "tool_use" }; }
    else yield { type: "stop", reason: "end_turn" };
  });
  const events: HarnessEvent[] = [];
  const priorExitCode = process.exitCode;
  try {
    const summary = await runCommand("Choose format", { root: join(root, "sessions"), provider: "anthropic", model: "fixture",
      yolo: true, headless: true, sandbox: "none", repoMap: false, maxTurns: "3", maxTokensPerTurn: "1000",
      skillDiscovery: false, extensionDiscovery: false, packages: false, diagnostics: [],
      supervisorSoft: "0.9", supervisorTurnsRemaining: "1", dreamEverySessions: "1", dreamEveryHours: "1",
      answerPolicy: mode === "file" ? `file:${answers}` : mode,
    }, { quiet: true, observe: event => { events.push(event); } });
    expect(summary?.reason).toBe(mode === "fail" ? "error" : "done");
    expect(calls).toBe(mode === "fail" ? 1 : 2);
    expect(events.find(event => event.type === "question.answered")).toMatchObject(mode === "fail"
      ? { outcome: "unavailable" } : { outcome: "answered", reply: { source: mode } });
  } finally { process.exitCode = priorExitCode; }
});
