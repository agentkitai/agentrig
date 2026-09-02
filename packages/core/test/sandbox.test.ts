import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DockerSandboxProvider,
  NoneSandboxProvider,
  SandboxDeniedError,
  SandboxMode,
  SeatbeltSandboxProvider,
  bashTool,
  sandboxSpawnInvocation,
  seatbeltProfile,
} from "@agentkitai/agentrig-core";

const execFileAsync = promisify(execFile);

describe("sandbox provider contract", () => {
  it("accepts exactly the three roadmap modes", () => {
    expect(SandboxMode.options).toEqual(["read-only", "workspace-write", "none"]);
    expect(SandboxMode.safeParse("full-access").success).toBe(false);
  });

  it("constructs an explicit provider denial with its cause", () => {
    const denial = new SandboxDeniedError("operation not permitted", { cause: new Error("EPERM") });
    expect(denial).toBeInstanceOf(Error);
    expect(denial.name).toBe("SandboxDeniedError");
    expect(denial.message).toBe("operation not permitted");
    expect(denial.cause).toBeInstanceOf(Error);
  });
});

describe("R2b sandbox providers", () => {
  it("keeps today's behavior as an explicit none provider", async () => {
    const provider = new NoneSandboxProvider();
    let calls = 0;
    const command = async () => {
      calls += 1;
      return sandboxSpawnInvocation("tool", ["arg"], "/work");
    };

    await expect(provider.prepare(command, { mode: "workspace-write", cwd: "/work" })())
      .resolves.toEqual({ command: "tool", args: ["arg"], sandboxed: false });
    expect(calls).toBe(1);
  });

  it("builds docker with a read-only root, cwd bind mode, and deny-network default", async () => {
    const provider = new DockerSandboxProvider({ image: "agentrig-test:local" });
    const invocation = async (mode: "read-only" | "workspace-write", network = false) => provider.prepare(
      // A process tool's cwd argument cannot widen the provider's prepared workspace policy.
      async () => sandboxSpawnInvocation("/bin/sh", ["-c", "echo ok"], "/attempted-widen"),
      { mode, cwd: "/work/project", network },
    )();

    const writable = await invocation("workspace-write");
    expect(writable.command).toBe("docker");
    expect(writable.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--read-only", "--network", "none",
      "--mount", "type=bind,src=/work/project,dst=/work/project,rw",
      "--workdir", "/work/project", "agentrig-test:local", "/bin/sh", "-c", "echo ok",
    ]));

    const readOnly = await invocation("read-only");
    expect(readOnly.args).toContain("type=bind,src=/work/project,dst=/work/project,readonly");
    expect(readOnly.args).not.toContain("type=bind,src=/work/project,dst=/work/project,rw");

    const networked = await invocation("workspace-write", true);
    expect(networked.args).not.toEqual(expect.arrayContaining(["--network", "none"]));
    expect(networked.args.filter((arg) => arg === "--network")).toHaveLength(0);
  });

  it("builds a deny-network seatbelt profile with writes scoped to an escaped workspace", () => {
    const workspace = "/tmp/a\"project\nname";
    const writable = seatbeltProfile({ mode: "workspace-write", cwd: workspace });
    expect(writable).toContain("(deny default)");
    expect(writable).toContain("(deny network*)");
    expect(writable).toContain("(allow file-read*)");
    expect(writable).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`);

    const networked = seatbeltProfile({ mode: "workspace-write", cwd: workspace, network: true });
    expect(networked).toContain("(allow network*)");
    expect(networked).not.toContain("(deny network*)");

    const readOnly = seatbeltProfile({ mode: "read-only", cwd: workspace });
    expect(readOnly).not.toContain("file-write");
  });

  it("routes foreground bash through the selected provider", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-seatbelt-")));
    try {
      const wrapper = join(root, "fake-sandbox-exec");
      await writeFile(wrapper, "#!/bin/sh\necho wrapped-by-seatbelt >&2\nshift 2\nexec \"$@\"\n");
      await chmod(wrapper, 0o755);
      const provider = new SeatbeltSandboxProvider({ command: wrapper });
      const result = await provider.prepare(
        () => bashTool().execute({ command: "printf sandboxed" }, {
          cwd: root,
          sessionId: "sandbox-test",
          emit: () => {},
          signal: new AbortController().signal,
        }),
        { mode: "workspace-write", cwd: root },
      )();
      expect(result.output.stdout).toBe("sandboxed");
      expect(result.output.stderr).toContain("wrapped-by-seatbelt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns a provider-shaped bash denial into SandboxDeniedError", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-deny-")));
    try {
      const wrapper = join(root, "denying-docker");
      await writeFile(wrapper, "#!/bin/sh\necho 'touch: Read-only file system' >&2\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const command = provider.prepare(
        () => bashTool().execute({ command: "echo must-not-run" }, {
          cwd: root,
          sessionId: "sandbox-test",
          emit: () => {},
          signal: new AbortController().signal,
        }),
        { mode: "workspace-write", cwd: root },
      );
      await expect(command()).rejects.toBeInstanceOf(SandboxDeniedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("docker provider integration", () => {
  const image = process.env.AGENTRIG_DOCKER_TEST_IMAGE ?? "alpine:3.20";
  let reason: string | undefined;

  it("denies a write outside cwd when docker and the local fixture image are available", async (ctx) => {
    try {
      await execFileAsync("docker", ["info"], { timeout: 10_000 });
    } catch {
      reason = "DOCKER INTEGRATION SKIPPED LOUDLY: `docker info` is unavailable";
    }
    if (reason === undefined) {
      try {
        await execFileAsync("docker", ["image", "inspect", image], { timeout: 10_000 });
      } catch {
        reason = `DOCKER INTEGRATION SKIPPED LOUDLY: local fixture image ${image} is absent (tests never pull)`;
      }
    }
    if (reason !== undefined) {
      console.warn(`\n*** ${reason} ***\n`);
      ctx.skip();
      return;
    }

    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-integration-")));
    try {
      const provider = new DockerSandboxProvider({ image });
      const invocation = await provider.prepare(
        async () => sandboxSpawnInvocation("/bin/sh", ["-c", "touch /outside-agentrig"], root),
        { mode: "workspace-write", cwd: root },
      )();
      await expect(execFileAsync(invocation.command, invocation.args, { timeout: 20_000 }))
        .rejects.toMatchObject({ stderr: expect.stringMatching(/read-only file system/iu) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
