import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { describeShellOperation, PermissionGrantRegistry, resolveShell, type HarnessEvent, type ModelEvent } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const shell = resolveShell();
it.skipIf(describeShellOperation("printf x", shell.path).status !== "parsed")("CLI builder enforces explicit live argv grants against real inert shell commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-grant-runtime-")); roots.push(root);
  vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key");
  const grants = new PermissionGrantRegistry(); let asks = 0;
  const built = await buildAgent({ root, provider: "anthropic", model: "test", shell: shell.path, maxTurns: "5", maxTokensPerTurn: "100" }, {
    permissionGrants: grants,
    onAsk: async req => {
      if (asks++ !== 0) return "deny";
      grants.grant({ subject: grants.subject, operation: { tool: "bash", class: "exec", commandPrefix: ["printf", "%s"] },
        resource: "*", constraints: {}, duration: { kind: "session", id: grants.context.sessionId! }, delegable: false, decision: "allow" });
      expect(req.operation?.status).toBe("parsed"); return "allow";
    },
  });
  const commands = ["printf '%s' first", "printf '%s' 'second; literal'", "printf '%s' third; printf '%s' expanded"];
  vi.spyOn(built.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    const command = commands.shift();
    if (command !== undefined) yield { type: "tool_use", id: `t${commands.length}`, name: "bash", input: { command } };
    yield { type: "stop", reason: command === undefined ? "end_turn" : "tool_use" };
  });
  const session = built.agent.run("use explicit scope", { cwd: root }); const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event); await session.done;
  expect(asks).toBe(2);
  expect(events.filter(e => e.type === "tool.result").map(e => e.type === "tool.result" && e.display)).toEqual(["first", "second; literal"]);
  expect(events.filter(e => e.type === "permission.granted")).toHaveLength(1);
  expect(events.filter(e => e.type === "tool.denied")).toHaveLength(1);
});
