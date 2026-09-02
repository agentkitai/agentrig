import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DockerSandboxProvider,
  NoneSandboxProvider,
  SeatbeltSandboxProvider,
  type ModelEvent,
} from "@agentkitai/agentrig-core";
import { buildAgent, buildSandbox } from "../src/agent-builder.ts";

describe("CLI sandbox wiring", () => {
  it("routes the assembled parent agent through the selected provider, including Windows none", async () => {
    const mode = process.env.AGENTRIG_CI_SANDBOX ?? "none";
    const root = await mkdtemp(join(tmpdir(), "agentrig-sandbox-wire-"));
    const fixture = join(root, "fixture.txt");
    await writeFile(fixture, "sandbox reached", "utf8");
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    const prepare = vi.spyOn(NoneSandboxProvider.prototype, "prepare");

    try {
      const built = await buildAgent({
        root,
        provider: "anthropic",
        model: "m",
        sandbox: mode,
        maxTurns: "2",
        maxTokensPerTurn: "1024",
        repoMap: false,
      } as never);
      let turn = 0;
      built.provider.stream = async function* (): AsyncIterable<ModelEvent> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_use", id: "read-1", name: "read_file", input: { path: fixture } };
          yield { type: "usage", usage: { input: 1, output: 1 } };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "usage", usage: { input: 1, output: 1 } };
        yield { type: "stop", reason: "end_turn" };
      };

      await built.agent.run("read the fixture", { cwd: root }).done;

      expect(mode).toBe("none");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]?.[1]).toEqual({ mode: "none", cwd: root });
    } finally {
      prepare.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects the platform provider without coupling sandbox mode to approvals", () => {
    expect(buildSandbox("workspace-write", "linux")).toMatchObject({
      mode: "workspace-write",
      provider: expect.any(DockerSandboxProvider),
    });
    expect(buildSandbox("read-only", "darwin")).toMatchObject({
      mode: "read-only",
      provider: expect.any(SeatbeltSandboxProvider),
    });
  });

  it("uses the real no-op provider for sandbox=none on every platform", async () => {
    const sandbox = buildSandbox("none", "win32");
    expect(sandbox.provider).toBeInstanceOf(NoneSandboxProvider);
    const command = async () => "ran";
    expect(sandbox.provider.prepare(command, { mode: sandbox.mode, cwd: "C:\\work" })).toBe(command);
    await expect(sandbox.provider.prepare(command, { mode: sandbox.mode, cwd: "C:\\work" })()).resolves.toBe("ran");
  });

  it("fails closed when a requested boundary has no provider on the host", () => {
    expect(() => buildSandbox("workspace-write", "win32")).toThrow(
      /not supported on win32.*--sandbox none/,
    );
  });
});
