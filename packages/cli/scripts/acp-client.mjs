#!/usr/bin/env node
// Explicit demonstration client. It never grants standing permission or approves unattended.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const [cwd, task, ...flags] = process.argv.slice(2);
if (!cwd || !task) throw new Error('usage: node packages/cli/scripts/acp-client.mjs <cwd> "<task>" [agentrig flags...]');
const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "acp", ...flags], { stdio: ["pipe", "pipe", "inherit"] });
const exited = once(child, "close");
const peer = client().onRequest("session/request_permission", async ({ params, signal }) => {
  let optionId = "deny";
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const description = params.toolCall.content?.filter(item => item.type === "content" && item.content.type === "text").map(item => item.content.text).join("\n") ?? "";
      const answer = await prompt.question(`${params.toolCall.title}\n${description}\nAllow this one request? [y/N] `, { signal });
      if (/^y(?:es)?$/iu.test(answer.trim())) optionId = "allow";
    } catch { /* cancelled question is denied */ }
    finally { prompt.close(); }
  }
  return { outcome: { outcome: "selected", optionId } };
}).onNotification("session/update", ({ params }) => {
  if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") process.stdout.write(params.update.content.text);
}).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
let sessionId;
const cancel = () => { if (sessionId) void peer.agent.notify("session/cancel", { sessionId }).catch(() => {}); };
process.on("SIGINT", cancel);
try {
  await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agentrig-example", version: "1" } });
  ({ sessionId } = await peer.agent.request("session/new", { cwd: resolve(cwd), mcpServers: [] }));
  const result = await peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: task }] });
  process.stdout.write(`\n[${result.stopReason}]\n`);
} finally {
  process.off("SIGINT", cancel); peer.close(); child.stdin.end(); await exited;
}
