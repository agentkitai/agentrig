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
  deniedPath,
  sandboxSpawnInvocation,
  writeDenialPlausible,
  seatbeltProfile,
  JobRegistry,
  bashJobTool,
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
      "--mount", "type=bind,src=/work/project,dst=/work/project",
      "--workdir", "/work/project", "agentrig-test:local", "/bin/sh", "-c", "echo ok",
    ]));

    const readOnly = await invocation("read-only");
    expect(readOnly.args).toContain("type=bind,src=/work/project,dst=/work/project,readonly");
    expect(readOnly.args).not.toContain("type=bind,src=/work/project,dst=/work/project");

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

  it("a generic 'operation not permitted' is an ordinary failure, never a sandbox denial", async () => {
    // every EPERM a command can hit reads this way, sandbox or not — and a command can print it
    // on purpose to talk its way into an escalation prompt
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-eperm-")));
    try {
      const wrapper = join(root, "docker");
      await writeFile(wrapper, "#!/bin/sh\necho 'rm: cannot remove: Operation not permitted' >&2\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const result = await provider.prepare(
        () => bashTool().execute({ command: "echo must-not-run" }, {
          cwd: root,
          sessionId: "sandbox-test",
          emit: () => {},
          signal: new AbortController().signal,
        }),
        { mode: "workspace-write", cwd: root },
      )();
      expect(result.output.exitCode).toBe(1);
      expect(result.isError).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a network denial counts only under a policy that denies network, and names its provenance", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-net-")));
    try {
      const wrapper = join(root, "docker");
      await writeFile(wrapper, "#!/bin/sh\necho 'wget: network is unreachable' >&2\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const run = (policy: { mode: "workspace-write"; cwd: string; network?: boolean }) =>
        provider.prepare(
          () => bashTool().execute({ command: "wget example" }, {
            cwd: root,
            sessionId: "sandbox-test",
            emit: () => {},
            signal: new AbortController().signal,
          }),
          policy,
        )();
      // network granted: the sandbox could not have produced this, so it is the command's problem
      const granted = await run({ mode: "workspace-write", cwd: root, network: true });
      expect(granted.output.exitCode).toBe(1);
      // network denied (the default): a boundary denial, with the words attributed to the command
      await expect(run({ mode: "workspace-write", cwd: root })).rejects.toMatchObject({
        name: "SandboxDeniedError",
        message: expect.stringMatching(/^reported by the command's own stderr \(unauthenticated\): wget: network is unreachable/u),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a background job's denial survives an intermediate poll and is reported once", async () => {
    // bash_job hands each poll only what is new; a denial printed early and drained by a status
    // call must still classify the exit
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-bg-")));
    const registry = new JobRegistry();
    try {
      const wrapper = join(root, "docker");
      await writeFile(wrapper, "#!/bin/sh\necho 'touch: Read-only file system' >&2\nsleep 0.4\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const ctx = { cwd: root, sessionId: "sandbox-test", emit: () => {}, signal: new AbortController().signal };
      const policy = { mode: "workspace-write" as const, cwd: root };
      const started = await provider.prepare(
        () => bashTool({ jobs: registry }).execute({ command: "touch /outside", background: true }, ctx),
        policy,
      )();
      const id = /started background job (job-\d+)/u.exec(started.display)?.[1];
      expect(id).toBeDefined();
      const status = (waitMs?: number) =>
        provider.prepare(
          () => bashJobTool(registry).execute({ id: id!, action: "status", ...(waitMs === undefined ? {} : { waitMs }) }, ctx),
          policy,
        )();
      // give the early line time to arrive, then drain it while the job is still running
      await new Promise((r) => setTimeout(r, 150));
      const early = await status();
      expect(early.output.running).toBe(true);
      expect(early.output.output).toContain("Read-only file system");
      // the exit poll sees no new output — and must still classify the denial
      await expect(status(2_000)).rejects.toBeInstanceOf(SandboxDeniedError);
      // once: a later poll of the same exited job reports plainly
      const after = await status();
      expect(after.output.running).toBe(false);
      expect(after.output.exitCode).toBe(1);
    } finally {
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the poll that reports a denial leaves its own drain for the next poll", async () => {
    // classification runs before read(): output that arrived since the previous poll must not be
    // consumed by the throw and then reported as "(no new output)"
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-bg2-")));
    const registry = new JobRegistry();
    try {
      const wrapper = join(root, "docker");
      await writeFile(wrapper, "#!/bin/sh\necho 'touch: Read-only file system' >&2\nsleep 0.3\necho FINAL-STDOUT-LINE\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const ctx = { cwd: root, sessionId: "sandbox-test", emit: () => {}, signal: new AbortController().signal };
      const policy = { mode: "workspace-write" as const, cwd: root };
      const started = await provider.prepare(
        () => bashTool({ jobs: registry }).execute({ command: "touch /outside", background: true }, ctx),
        policy,
      )();
      const id = /started background job (job-\d+)/u.exec(started.display)![1]!;
      const status = (waitMs?: number) =>
        provider.prepare(
          () => bashJobTool(registry).execute({ id, action: "status", ...(waitMs === undefined ? {} : { waitMs }) }, ctx),
          policy,
        )();
      await new Promise((r) => setTimeout(r, 120));
      await status(); // drains the early denial line while the job runs
      await expect(status(2_000)).rejects.toBeInstanceOf(SandboxDeniedError);
      const after = await status();
      expect(after.output.output).toContain("FINAL-STDOUT-LINE");
    } finally {
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a denial buried under a long log is still classified from the retained head", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-bg3-")));
    const registry = new JobRegistry();
    try {
      const wrapper = join(root, "docker");
      // the denial first, then well over the retained tail's worth of output
      await writeFile(
        wrapper,
        // Keep denial and padding on one pipe: stdout/stderr delivery order is unspecified even when
        // the child writes stderr first, which made this retained-head assertion timing-dependent.
        "#!/bin/sh\necho 'touch: Read-only file system' >&2\ni=0\nwhile [ $i -lt 400 ]; do echo 'build log line padding padding padding padding' >&2; i=$((i+1)); done\nexit 1\n",
      );
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      const ctx = { cwd: root, sessionId: "sandbox-test", emit: () => {}, signal: new AbortController().signal };
      const policy = { mode: "workspace-write" as const, cwd: root };
      const started = await provider.prepare(
        () => bashTool({ jobs: registry }).execute({ command: "touch /outside", background: true }, ctx),
        policy,
      )();
      const id = /started background job (job-\d+)/u.exec(started.display)![1]!;
      await expect(
        provider.prepare(() => bashJobTool(registry).execute({ id, action: "status", waitMs: 3_000 }, ctx), policy)(),
      ).rejects.toBeInstanceOf(SandboxDeniedError);
    } finally {
      registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seatbelt ignores a network denial under a network grant", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-seatbelt-net-")));
    try {
      const wrapper = join(root, "sandbox-exec");
      await writeFile(wrapper, "#!/bin/sh\necho 'sandbox-exec: deny network-outbound' >&2\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new SeatbeltSandboxProvider({ command: wrapper });
      const run = (policy: { mode: "workspace-write"; cwd: string; network?: boolean }) =>
        provider.prepare(
          () => bashTool().execute({ command: "curl example" }, {
            cwd: root,
            sessionId: "sandbox-test",
            emit: () => {},
            signal: new AbortController().signal,
          }),
          policy,
        )();
      const granted = await run({ mode: "workspace-write", cwd: root, network: true });
      expect(granted.output.exitCode).toBe(1);
      await expect(run({ mode: "workspace-write", cwd: root })).rejects.toBeInstanceOf(SandboxDeniedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a denial is corroborated against the policy before it counts (#95)", () => {
  it("deniedPath reads a quoted path, else the first absolute token, else nothing", () => {
    expect(deniedPath("touch: cannot touch '/etc/x': Read-only file system")).toBe("/etc/x");
    expect(deniedPath('mkdir: cannot create directory "/opt/a b": Read-only file system')).toBe("/opt/a b");
    expect(deniedPath("touch: cannot touch 'notes/x.md': Read-only file system")).toBe("notes/x.md");
    expect(deniedPath("sandbox-exec: deny(1) file-write-create /Users/me/work/out.txt")).toBe("/Users/me/work/out.txt");
    expect(deniedPath("EROFS: read-only file system, open /var/lib/thing")).toBe("/var/lib/thing");
    expect(deniedPath("touch: Read-only file system")).toBeUndefined();
    expect(deniedPath("touch: cannot touch 'notes.md': Read-only file system")).toBeUndefined();
    expect(deniedPath("error: 'Read-only file system'")).toBeUndefined();
    expect(deniedPath("wget: network is unreachable")).toBeUndefined();
  });

  it("writeDenialPlausible: inside a writable workspace is implausible, everything else stays a denial", () => {
    const cwd = "/work/proj";
    const ww = { mode: "workspace-write" as const, cwd };
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/a': Read-only file system", ww)).toBe(false);
    expect(writeDenialPlausible("touch: cannot touch 'sub/a': Read-only file system", ww)).toBe(false);
    expect(writeDenialPlausible("touch: cannot touch '/work/proj': Read-only file system", ww)).toBe(false);
    // a sibling that merely shares the prefix is outside
    expect(writeDenialPlausible("touch: cannot touch '/work/proj2/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("touch: cannot touch '/etc/a': Read-only file system", ww)).toBe(true);
    // .. cannot smuggle an outside path in as inside, nor the reverse
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/../proj2/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("touch: cannot touch '/etc/../work/proj/a': Read-only file system", ww)).toBe(false);
    // no path: the pattern alone decides, as before
    expect(writeDenialPlausible("touch: Read-only file system", ww)).toBe(true);
    // read-only mode denies every path, the workspace included
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/a': Read-only file system", { mode: "read-only", cwd })).toBe(true);
  });

  const dockerRun = async (stderrLine: string, mode: "workspace-write" | "read-only") => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-path-")));
    try {
      const wrapper = join(root, "docker");
      const line = stderrLine.replace("CWD", root);
      await writeFile(wrapper, `#!/bin/sh\necho "${line}" >&2\nexit 1\n`);
      await chmod(wrapper, 0o755);
      const provider = new DockerSandboxProvider({ command: wrapper, image: "unused" });
      return await provider.prepare(
        () => bashTool().execute({ command: "touch something" }, {
          cwd: root,
          sessionId: "sandbox-test",
          emit: () => {},
          signal: new AbortController().signal,
        }),
        { mode, cwd: root },
      )();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it("docker: a read-only line about a path inside the writable workspace is the command's problem, not a denial", async () => {
    // forged, or a host mount inside cwd that is read-only for its own reasons: either way the
    // container did not produce it, and it must not earn an escalation prompt
    const result = await dockerRun("touch: cannot touch 'CWD/notes.md': Read-only file system", "workspace-write");
    expect(result.output.exitCode).toBe(1);
    expect(result.isError).toBe(true);
    const relative = await dockerRun("touch: cannot touch 'sub/notes.md': Read-only file system", "workspace-write");
    expect(relative.output.exitCode).toBe(1);
    // a bare quoted word is not a recognisable path (the quoted phrase could be anything), so the
    // pattern alone decides and it stays a denial — corroboration narrows, never widens
    await expect(dockerRun("touch: cannot touch 'notes.md': Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
  });

  it("docker: the same line about a path outside the workspace, or under read-only, is still a denial", async () => {
    await expect(dockerRun("touch: cannot touch '/etc/notes.md': Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
    await expect(dockerRun("touch: cannot touch 'CWD/notes.md': Read-only file system", "read-only"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
    // and a line naming no path keeps today's classification
    await expect(dockerRun("touch: Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
  });

  it("seatbelt: a file-write denial inside the workspace the profile allows is dropped; outside it counts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-seatbelt-path-")));
    try {
      const run = async (line: string) => {
        const wrapper = join(root, "sandbox-exec");
        await writeFile(wrapper, `#!/bin/sh\necho "${line.replace("CWD", root)}" >&2\nexit 1\n`);
        await chmod(wrapper, 0o755);
        const provider = new SeatbeltSandboxProvider({ command: wrapper });
        return provider.prepare(
          () => bashTool().execute({ command: "touch x" }, {
            cwd: root,
            sessionId: "sandbox-test",
            emit: () => {},
            signal: new AbortController().signal,
          }),
          { mode: "workspace-write", cwd: root },
        )();
      };
      const inside = await run("sandbox-exec: deny(1) file-write-create CWD/x");
      expect(inside.output.exitCode).toBe(1);
      await expect(run("sandbox-exec: deny(1) file-write-create /etc/x")).rejects.toBeInstanceOf(SandboxDeniedError);
      // a non-write denial is untouched by the path check
      await expect(run("sandbox-exec: deny(1) network-outbound")).rejects.toBeInstanceOf(SandboxDeniedError);
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
