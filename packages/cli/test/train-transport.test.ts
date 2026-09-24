import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { RulePolicy } from "@agentkitai/agentrig-core";
import { trainCommand } from "../src/train.js";
import { cliEnv } from "./cli-env.js";

it("actual headless run reports validated final PR to host outside checkout with all child writes denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "train-transport-"));
  const checkout = join(root, "checkout"), home = join(root, "home"), resultPath = join(root, "logs/result.json");
  await mkdir(checkout); await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(join(root, "logs"));
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false, toolSummaries: false }));
  const schema = join(root, "logs/schema.json");
  await writeFile(schema, JSON.stringify({ type: "object", properties: { pr: { type: "integer", minimum: 1 } }, required: ["pr"], additionalProperties: false }));
  // The former model write would ask under the project's cwd confinement policy.
  const confined = new RulePolicy([{ class: "write", cwdOnly: true, decision: "allow" }]);
  expect(await confined.decide({ tool: "write_file", class: "write", paths: [resultPath], cwd: checkout, input: {} })).toBe("ask");
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"pr":42}' }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
  try {
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) vi.stubEnv(key, home);
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    const result = await trainCommand({ env: cliEnv(), executable: process.execPath, argv: [
      fileURLToPath(new URL("../dist/index.js", import.meta.url)), "run", "--headless", "--json", "--output-schema", schema,
      "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`,
      "--root", join(root, "sessions"), "--memory", join(root, "memory"), "--deny", "write",
      "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery", "Return the PR as final JSON.",
    ], cwd: checkout, log: join(root, "logs/child.log"), resultPath });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ pr: 42 });
    expect(result.stdout).toContain('"type":"output.validated"');
    expect(result.stdout).not.toContain('"type":"permission.request"');
    expect(result.stdout).not.toContain('"type":"tool.call"');
  } finally {
    vi.unstubAllEnvs(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
