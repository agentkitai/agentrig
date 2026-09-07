import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { readOutputContract } from "../src/output-schema.js";
import { HarnessEvent } from "@agentkitai/agentrig-core";
import { renderEvent, renderChatEvent } from "../src/render.js";

const exec = promisify(execFile), roots: string[] = [];
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentrig-schema-cli-")); roots.push(root);
  await mkdir(join(root, "home")); await writeFile(join(root, "schema.json"), JSON.stringify(schema));
  await writeFile(join(root, "task.txt"), "Produce an answer."); return root;
}
async function actual(root: string, deltas: Record<string, unknown>[], args: string[] = []) {
  // Isolate main-loop assertions from the recommended session-end auxiliary call.
  await mkdir(join(root, ".agentrig"), { recursive: true });
  await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false }));
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += chunk; bodies.push(JSON.parse(input));
    const delta = deltas[bodies.length - 1] ?? { content: "unexpected request" };
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener missing");
  try {
    const argv = [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "run", "--provider", "openai", "--model", "fixture",
      "--base-url", `http://127.0.0.1:${address.port}/v1`, "--root", join(root, "logs"), "--trust", "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery",
      "--output-schema", "schema.json", ...(args.includes("--ci") ? [] : ["--headless", "Produce an answer."]), ...args];
    try { return { code: 0, bodies, ...await exec(process.execPath, argv, { cwd: root, timeout: 15_000,
      env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), OPENAI_API_KEY: "fixture-key" } }) }; }
    catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; if (typeof e.code !== "number") throw error;
      return { code: e.code, bodies, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }; }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function log(root: string) {
  const names = await readdir(join(root, "logs")); return readFile(join(root, "logs", names.find(name => name.endsWith(".jsonl"))!), "utf8");
}
it.each(["prompted", "native"])("actual %s CLI validates locally, repairs once and preserves raw logs", async mode => {
  const root = await fixture(); const result = await actual(root, [{ content: "raw-invalid-answer" }, { content: '{"ok":true}' }], ["--output-mode", mode]);
  expect(result.code, result.stderr).toBe(0); expect(result.bodies).toHaveLength(2);
  expect(result.bodies[1].tools ?? []).toEqual([]);
  for (const body of result.bodies) expect(body.response_format).toEqual(mode === "native" ? { type: "json_schema", json_schema: { name: "agentrig_output", strict: true, schema } } : undefined);
  const raw = await log(root); expect(raw).toContain("raw-invalid-answer"); expect(raw).toContain('"attempt":"repair","valid":true');
}, 30_000);
it("native streaming refusal is retained without automatic fallback or repair", async () => {
  const root = await fixture(); const result = await actual(root, [{ refusal: "fixture-refusal-text" }], ["--output-mode", "native"]);
  expect(result.code).toBe(1); expect(result.bodies).toHaveLength(1); expect(await log(root)).toContain("fixture-refusal-text");
}, 30_000);
it("actual CI invalid repair fails with bounded status and no dispatched repair tool", async () => {
  const root = await fixture();
  const result = await actual(root, [{ content: "invalid" }, { tool_calls: [{ index: 0, id: "repair-write", type: "function", function: {
    name: "write_file", arguments: JSON.stringify({ path: "sentinel", content: "unsafe" }) } }] }], ["--ci", "--task-file", "task.txt", "--report", "report.md", "--allow", "write"]);
  expect(result.code).toBe(1); expect(result.bodies).toHaveLength(2);
  await expect(readFile(join(root, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
  const report = await readFile(join(root, "report.md"), "utf8"); expect(report).toContain("Outcome: error"); expect(report).toContain("Output validation:"); expect(report).toContain("invalid");
  expect(await log(root)).toContain("not executed");
}, 30_000);
it("malformed duplicate schemas and unsupported native adapters refuse before provider requests", async () => {
  const root = await fixture();
  for (const raw of ['{"type":"string","type":"number"}', '{"type":"string","pattern":"secret-canary"}', " ".repeat(32769)]) {
    await writeFile(join(root, "schema.json"), raw); const result = await actual(root, []);
    expect(result.code).toBe(1); expect(result.bodies).toHaveLength(0); expect(result.stdout + result.stderr).not.toContain("secret-canary");
  }
  await writeFile(join(root, "schema.json"), JSON.stringify(schema));
  const result = await actual(root, [], ["--output-mode", "native", "--provider", "anthropic"]);
  expect(result.code).toBe(1); expect(result.bodies).toHaveLength(0);
}, 30_000);
it("file loader preserves boolean schema semantics and rejects malformed UTF-8", async () => {
  const root = await fixture(), path = join(root, "schema.json"); await writeFile(path, "false");
  expect((await readOutputContract(path, "prompted")).validate("null")).toBe("schema");
  await writeFile(path, Buffer.from([0xff])); await expect(readOutputContract(path, "prompted")).rejects.toThrow("Output schema file refused");
});
it("both renderers retain bounded validation status", () => {
  const event = HarnessEvent.parse({ type: "output.validated", digest: "a".repeat(64), mode: "prompted", attempt: "repair", valid: false, category: "schema", sessionId: "fixture", ts: 1, seq: 1 });
  expect(renderEvent(event)).toContain("schema"); expect(renderChatEvent(event)).toContain("invalid");
});
