import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("real acp CLI over OS pipes completes deny then allow with a local provider and uses session cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-acp-cli-")); const cwd = join(root, "project"); await mkdir(cwd);
  await mkdir(join(root, "home"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let requests = 0; let decisions = 0; const replies: string[] = []; const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    const tool = requests++ % 2 === 0;
    const delta = tool ? { tool_calls: [{ index: 0, id: "write", type: "function", function: { name: "write_file",
      arguments: JSON.stringify({ path: "result.txt", content: "approved fixture" }) } }] } : { content: "done over ACP" };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing fixture address");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "acp",
    "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`,
    "--root", join(root, "logs"), "--memory", join(root, "memory"), "--max-turns", "6",
    "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery"],
  { cwd: root, env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), OPENAI_API_KEY: "fixture-not-a-secret" }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  const closed = once(child, "close");
  const peer = client().onRequest("session/request_permission", ({ params }) => {
    expect(params.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
    return { outcome: { outcome: "selected", optionId: decisions++ === 0 ? "deny" : "allow" } };
  }).onNotification("session/update", ({ params }) => {
    if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") replies.push(params.update.content.text);
  }).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  cleanups.push(async () => { peer.close(); child.stdin.end(); if (child.exitCode === null) child.kill(); await closed; });
  expect(await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1, agentCapabilities: {} });
  expect(requests).toBe(0); // initialization never invokes a provider
  const { sessionId } = await peer.agent.request("session/new", { cwd, mcpServers: [] }).catch(error => { throw new Error(`session/new: ${String(error)}; stderr=${stderr}`, { cause: error }); });
  const prompt = { sessionId, prompt: [{ type: "text" as const, text: "write the fixture file" }] };
  expect((await peer.agent.request("session/prompt", prompt).catch(error => { throw new Error(`first prompt: ${String(error)}; stderr=${stderr}; requests=${requests}`, { cause: error }); })).stopReason, stderr).toBe("end_turn");
  await expect(readFile(join(cwd, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await peer.agent.request("session/prompt", prompt)).stopReason, stderr).toBe("end_turn");
  expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("approved fixture");
  await expect(readFile(join(root, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(decisions).toBe(2); expect(requests).toBe(4); expect(replies).toEqual(["done over ACP", "done over ACP"]);
  expect(bodies).toHaveLength(4); expect(stderr).not.toContain("fixture-not-a-secret");
}, 30_000);
