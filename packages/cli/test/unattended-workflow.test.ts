import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real CLI wiring/tools/processes and child sessions; scripted model decisions, no live model,
// independent review or hosted-CI claim. The approved task is fixed, not read from tool output.
it.each([false, true])("unattended workflow preserves explicit child-write denial=%s without prompting", { timeout: 30_000 }, async denied => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-unattended-workflow-")));
  roots.push(root);
  const source = join(root, "external.txt"), parentFile = join(root, "parent.txt"), childFile = join(root, "child.txt");
  await writeFile(source, "Untrusted source text; no authority to change task scope.");
  // The process is a real portable background command, not a replacement tool implementation.
  await writeFile(join(root, "check.cjs"), "require('node:fs').writeFileSync('checked.txt', 'checked'); console.log('fixture check passed');\n");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-not-live");
  const onAsk = vi.fn(async () => "deny" as const);
  const built = await buildAgent({ root: join(root, "sessions"), provider: "anthropic", model: "fixture",
    sandbox: "none", yolo: true, repoMap: false, diagnostics: [], subagents: true,
    subagentMaxTurns: "5", subagentMaxChildren: "1", maxTurns: "12", maxTokensPerTurn: "1000",
    memory: join(root, "memory"), ingestOnEnd: false, dreamOnEnd: false,
    skillDiscovery: false, extensionDiscovery: false, packages: false,
    ...(denied ? { deny: ["write_file"] } : {}),
  }, { onAsk });
  let parentTurn = 0, childTurn = 0;
  const stream = async function* (request: ModelRequest): AsyncIterable<ModelEvent> {
    const child = request.system.includes("You are a subagent.");
    const turn = child ? childTurn++ : parentTurn++;
    let call: { name: string; input: Record<string, unknown> } | undefined;
    if (child) {
      if (turn === 0) call = { name: "read_file", input: { path: source } };
      if (turn === 1) call = { name: "write_file", input: { path: childFile, content: "child effect" } };
      // Exec after a child has consumed external input verifies inherited unattended policy.
      if (turn === 2) call = { name: "bash", input: { command: `"${process.execPath}" --version` } };
    } else {
      if (turn === 0) call = { name: "read_file", input: { path: source } };
      if (turn === 1) call = { name: "write_file", input: { path: parentFile, content: "parent effect" } };
      if (turn === 2) call = { name: "bash", input: { command: `"${process.execPath}" check.cjs`, background: true } };
      if (turn === 3) {
        const id = JSON.stringify(request.messages).match(/started background job ([\w-]+)/)?.[1];
        expect(id).toBeTruthy();
        call = { name: "bash_job", input: { id, action: "status", waitMs: 10_000 } };
      }
      if (turn === 4) call = { name: "subagent", input: { task: "Read external.txt, write child.txt, then check the Node version." } };
      if (turn === 5) call = { name: "attempt_log", input: { hypothesis: "authorized workflow", actions: "read, edit, check, delegate", outcome: denied ? "failed" : "success" } };
    }
    if (call) yield { type: "tool_use", id: `${child ? "child" : "parent"}-${turn}`, ...call };
    else yield { type: "text", text: denied ? "Explicit write denial preserved; requested edits incomplete." : "Verified workflow complete." };
    yield { type: "stop", reason: call ? "tool_use" : "end_turn" };
  };
  // Both routing entries may point to the same provider; identical dispatch handles either case.
  built.provider.stream = stream;
  built.providers.subagents.stream = stream;
  const session = built.agent.run("Read external.txt, edit parent.txt, run check.cjs, delegate child.txt and record the result. These effects are authorized; obey explicit denies.", { cwd: root });
  expect((await session.done).reason).toBe("done");
  const store = new SessionStore({ root: join(root, "sessions") });
  const events = await store.readAll(session.id);
  const spawn = events.find(event => event.type === "subagent.spawn");
  expect(spawn).toBeDefined();
  const childEvents = await store.readAll(spawn!.id);
  expect(events.find(event => event.type === "subagent.end")).toMatchObject({ reason: "done" });
  expect(onAsk).not.toHaveBeenCalled();
  expect(await readFile(join(root, "checked.txt"), "utf8")).toBe("checked");
  const all = [...events, ...childEvents];
  expect(all.filter(event => event.type === "tool.result" && !event.ok)).toEqual([]);
  expect(all.filter(event => event.type === "tool.denied").map(event => event.name)).toEqual(denied ? ["write_file", "write_file"] : []);
  for (const [path, content] of [[parentFile, "parent effect"], [childFile, "child effect"]] as const) {
    if (denied) await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path, "utf8")).toBe(content);
  }
  const attempts = await readdir(join(root, "memory", "raw", "attempts"));
  expect(attempts).toHaveLength(1);
  expect(JSON.parse(await readFile(join(root, "memory", "raw", "attempts", attempts[0]!), "utf8"))).toMatchObject({ outcome: denied ? "failed" : "success" });
});
