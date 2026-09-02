import { describe, expect, it } from "vitest";
import {
  DockerSandboxProvider,
  NoneSandboxProvider,
  SeatbeltSandboxProvider,
} from "@agentkitai/agentrig-core";
import { buildSandbox } from "../src/agent-builder.ts";

describe("CLI sandbox wiring", () => {
  it("proves the CI host's configured sandbox seam, including Windows none", () => {
    const mode = process.env.AGENTRIG_CI_SANDBOX;
    if (mode === undefined) return;
    const sandbox = buildSandbox(mode, process.platform);
    expect(sandbox.mode).toBe(mode);
    if (process.platform === "win32") expect(sandbox.provider).toBeInstanceOf(NoneSandboxProvider);
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
