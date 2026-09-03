import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DockerSandboxProvider,
  NoneSandboxProvider,
  SandboxDeniedError,
  SandboxMode,
  SeatbeltSandboxProvider,
  bashTool,
  classifiable,
  deniedPath,
  probeBudget,
  deniedPaths,
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
  it("deniedPaths reads every path a line names: quoted first, then bare tokens, relative ones as written", () => {
    expect(deniedPaths("touch: cannot touch '/etc/x': Read-only file system")).toEqual(["/etc/x"]);
    expect(deniedPaths('mkdir: cannot create directory "/opt/a b": Read-only file system')).toEqual(["/opt/a b"]);
    expect(deniedPaths("mkdir: cannot create directory ‘/etc/y’: Read-only file system")).toEqual(["/etc/y"]);
    expect(deniedPaths("sandbox-exec: deny(1) file-write-create /Users/me/work/out.txt")).toEqual(["/Users/me/work/out.txt"]);
    expect(deniedPaths("EROFS: read-only file system, open /var/lib/thing")).toEqual(["/var/lib/thing"]);
    expect(deniedPaths("Error: EROFS: read-only file system, copyfile '/work/proj/a' -> '/etc/x'")).toEqual(["/work/proj/a", "/etc/x"]);
    expect(deniedPaths("/work/proj/scripts/install.sh: line 12: /etc/x: Read-only file system")).toEqual(["/work/proj/scripts/install.sh", "/etc/x"]);
    expect(deniedPaths("tee: /etc/x: Read-only file system")).toEqual(["/etc/x"]);
    // relative paths are named as written — unknown to the boundary, never "inside"; a quoted
    // word without a slash or a dot is any phrase, not a path
    expect(deniedPaths("touch: cannot touch 'notes/x.md': Read-only file system")).toEqual(["notes/x.md"]);
    expect(deniedPaths("mv: cannot move '/work/proj/a' to '../../etc/x': Read-only file system")).toEqual(["/work/proj/a", "../../etc/x"]);
    expect(deniedPaths("/work/proj/deploy.sh: line 5: ../../etc/x: Read-only file system")).toEqual(["/work/proj/deploy.sh", "../../etc/x"]);
    // a quoted word without a slash is a target the boundary cannot judge — unknown, kept
    expect(deniedPaths("touch: cannot touch 'notes.md': Read-only file system")).toEqual(["notes.md"]);
    expect(deniedPaths("error: 'Read-only file system'")).toEqual(["Read-only file system"]);
    // so is the unquoted operand right before the errno text
    expect(deniedPaths("/work/proj/deploy.sh: line 5: hosts: Read-only file system")).toEqual(["/work/proj/deploy.sh", "hosts"]);
    expect(deniedPaths("/work/proj/deploy.sh: line 5: build/x: Read-only file system")).toEqual(["/work/proj/deploy.sh", "build/x"]);
    expect(deniedPaths("mv: cannot move '/work/proj/a' to 'x': Read-only file system")).toEqual(["/work/proj/a", "x"]);
    // the same path quoted and bare is one path
    expect(deniedPaths("cp: '/etc/x' -> /etc/x: Read-only file system")).toEqual(["/etc/x"]);
    // an unbalanced apostrophe elsewhere cannot hide a quoted path from the bare pass
    expect(deniedPaths("Can't write '/etc/x' from '/work/proj/a': Read-only file system")).toContain("/etc/x");
    expect(deniedPaths("ln: failed to create hard link '/etc/x' => '/work/proj/a': Read-only file system")).toEqual(["/etc/x", "/work/proj/a"]);
    expect(deniedPaths("EROFS: read-only file system, rename -> /etc/x")).toEqual(["/etc/x"]);
    // bounded: a line naming a thousand paths yields sixteen
    expect(deniedPaths(Array.from({ length: 1_000 }, (_, i) => `'/p/${i}'`).join(" "))).toHaveLength(16);
    expect(deniedPaths("touch: Read-only file system")).toEqual([]);
    expect(deniedPaths("wget: network is unreachable")).toEqual([]);
    expect(deniedPath("tee: /etc/x: Read-only file system")).toBe("/etc/x");
    expect(deniedPath("touch: Read-only file system")).toBeUndefined();
  });

  it("writeDenialPlausible: dropped only when every named path is inside the writable workspace", () => {
    const cwd = "/work/proj";
    const ww = { mode: "workspace-write" as const, cwd };
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/a': Read-only file system", ww)).toBe(false);
    expect(writeDenialPlausible("touch: cannot touch '/work/proj': Read-only file system", ww)).toBe(false);
    expect(writeDenialPlausible("tee: /work/proj: Read-only file system", ww)).toBe(false);
    // a sibling that merely shares the prefix is outside
    expect(writeDenialPlausible("touch: cannot touch '/work/proj2/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("touch: cannot touch '/etc/a': Read-only file system", ww)).toBe(true);
    // .. cannot smuggle an outside path in as inside, nor the reverse
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/../proj2/a': Read-only file system", ww)).toBe(true);
    // `/usr` rather than `/etc`: on macOS `/etc` is a link to `/private/etc`, so `/etc/../work`
    // really is `/private/work` — the walk agrees with the kernel, and the test must too
    expect(writeDenialPlausible("touch: cannot touch '/usr/../work/proj/a': Read-only file system", ww)).toBe(false);
    // an inside source named before the outside target is still the boundary speaking
    expect(writeDenialPlausible("Error: EROFS: read-only file system, copyfile '/work/proj/a' -> '/etc/x'", ww)).toBe(true);
    expect(writeDenialPlausible("Error: EROFS: read-only file system, rename '/work/proj/tmp' -> '/etc/x'", ww)).toBe(true);
    expect(writeDenialPlausible("/work/proj/scripts/install.sh: line 12: /etc/x: Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("mv: cannot move '/work/proj/a' to '/etc/x': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("/work/proj/bin/tool: open /etc/x: read-only file system", ww)).toBe(true);
    // a relative target is unknown, so a line naming one is never dropped, whatever else it names
    expect(writeDenialPlausible("touch: cannot touch 'sub/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("mv: cannot move '/work/proj/a' to '../../etc/x': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("/work/proj/deploy.sh: line 5: ../../etc/x: Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("Error: EROFS: read-only file system, copyfile '/work/proj/a' -> '../../etc/x'", ww)).toBe(true);
    // an unprefixed relative target after a cd, beside an inside script or source path
    expect(writeDenialPlausible("/work/proj/deploy.sh: line 5: hosts: Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("/work/proj/deploy.sh: line 5: build/x: Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("mv: cannot move '/work/proj/a' to 'x': Read-only file system", ww)).toBe(true);
    // the outside path first, an unbalanced apostrophe, a bare arrow target: all kept
    expect(writeDenialPlausible("ln: failed to create hard link '/etc/x' => '/work/proj/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("Can't write '/etc/x' from '/work/proj/a': Read-only file system", ww)).toBe(true);
    expect(writeDenialPlausible("EROFS: read-only file system, rename '/work/proj/a' -> /etc/x", ww)).toBe(true);
    expect(writeDenialPlausible("touch: Read-only file system", ww)).toBe(true);
    // a path longer than any filesystem accepts is judged by its string
    const huge = `/work/proj/${"a/".repeat(5_000)}x`;
    expect(writeDenialPlausible(`touch: cannot touch '${huge}': Read-only file system`, ww)).toBe(false);
    expect(writeDenialPlausible(`touch: cannot touch '/etc/${"a/".repeat(5_000)}x': Read-only file system`, ww)).toBe(true);
    // read-only mode denies every path, the workspace included
    expect(writeDenialPlausible("touch: cannot touch '/work/proj/a': Read-only file system", { mode: "read-only", cwd })).toBe(true);
  });

  it("deep paths under the length cap are resolved in logarithmic probes: a corroboration budget's worth stays fast", async () => {
    // sixteen 1900-component inside paths per line, fifty corroborated lines: the worst case the
    // budget allows. One lstat per component was 1.1s per LINE; binary search is milliseconds.
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-deep-")));
    try {
      const ww = { mode: "workspace-write" as const, cwd: root };
      const deep = Array.from({ length: 16 }, (_, i) => `'${root}/${"d/".repeat(1_900)}${i}'`).join(" ");
      expect(`${root}/${"d/".repeat(1_900)}0`.length).toBeLessThan(4_096);
      const line = `touch: cannot touch ${deep}: Read-only file system`;
      const t0 = Date.now();
      for (let i = 0; i < 50; i += 1) expect(writeDenialPlausible(line, ww)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a path deeper than sixty-four components is judged by its string: a real deep tree cannot make the walk slow", async () => {
    // a child may build a two-thousand-level tree inside the workspace; resolving leaves under it
    // cost one syscall per existing component, quadratic over the budget — minutes per stderr
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-deeptree-")));
    try {
      // 300 levels: past the sixty-four-component cap by a wide margin, under macOS's 1024-byte
      // PATH_MAX (a 700-level tree failed there with ENAMETOOLONG on mkdir)
      const deepDir = join(root, ...Array.from({ length: 300 }, () => "d"));
      await mkdir(deepDir, { recursive: true });
      const ww = { mode: "workspace-write" as const, cwd: root };
      const leaves = Array.from({ length: 16 }, (_, i) => `'${deepDir}/${i}'`).join(" ");
      const line = `touch: cannot touch ${leaves}: Read-only file system`;
      const t0 = Date.now();
      for (let i = 0; i < 100; i += 1) expect(writeDenialPlausible(line, ww)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1_500);
      // the string judgement past the cap: an outside string stays outside
      expect(writeDenialPlausible(`touch: cannot touch '/etc/${"d/".repeat(70)}x': Read-only file system`, ww)).toBe(true);
      // a path through a regular file, and a component longer than any name: absent, not a crash
      await writeFile(join(root, "file.txt"), "x");
      expect(writeDenialPlausible(`touch: cannot touch '${root}/file.txt/x': Read-only file system`, ww)).toBe(false);
      expect(writeDenialPlausible(`touch: cannot touch '${root}/${"n".repeat(300)}/x': Read-only file system`, ww)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a dangling chain with deep targets is followed link by link, inside the syscall budget", async () => {
    // twenty links, each pointing at the next one sixty directories down, the last dangling to
    // the outside: resolving the chain with a realpath per hop made the kernel re-walk the
    // remainder every time — quadratic in the hops, a hundred seconds per classification at forty
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-chain-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "agentrig-chain-out-")));
    try {
      // forty levels: with macOS's seven-component tmpdir the leaf stays under the sixty-four cap
      const deepDir = join(root, ...Array.from({ length: 40 }, () => "d"));
      expect(`${deepDir}/link0/x0`.split("/").filter(Boolean).length).toBeLessThan(64);
      await mkdir(deepDir, { recursive: true });
      // twenty hops: macOS resolves at most 32 symlinks (Linux 40), and past that limit a write
      // fails with ELOOP rather than EROFS, so a longer chain is judged by string — and dropped
      for (let i = 0; i < 20; i += 1) {
        const target = i === 19 ? join(outside, "newfile") : join(deepDir, `link${i + 1}`);
        await symlink(target, join(deepDir, `link${i}`));
      }
      const ww = { mode: "workspace-write" as const, cwd: root };
      const names = Array.from({ length: 16 }, (_, i) => `'${deepDir}/link0/x${i}'`).join(" ");
      const line = `touch: cannot touch ${names}: Read-only file system`;
      const t0 = Date.now();
      // the chain leads outside: a genuine denial, kept
      for (let i = 0; i < 50; i += 1) expect(writeDenialPlausible(line, ww, { budget: probeBudget() })).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1_500);
      // a two-link loop is not a write that fails with EROFS: judged by string, dropped
      await symlink(join(root, "b"), join(root, "a"));
      await symlink(join(root, "a"), join(root, "b"));
      expect(writeDenialPlausible(`touch: cannot touch '${root}/a/x': Read-only file system`, ww)).toBe(false);
      // an EXISTING chain whose every target is a long `w/x/../` walk through a link back to
      // the workspace (`w -> root`, `x` a real directory) costs its distinct paths — the memo —
      // not the platform realpath's re-walk of every hop's every component per call
      // ten hops, nine through a `w/x/..` wobble: nineteen link follows, under macOS's limit of
      // thirty-two (a chain past the kernel's limit fails ELOOP, not EROFS, and is judged by string)
      await mkdir(join(root, "x"));
      await symlink(root, join(root, "w"));
      const wobble = "w/x/../";
      for (let i = 0; i < 10; i += 1) {
        const target = i === 9 ? outside : `${root}/${wobble}e${i + 1}`;
        await symlink(target, join(root, `e${i}`));
      }
      const existingChain = Array.from({ length: 16 }, (_, i) => `'${root}/e0/y${i}'`).join(" ");
      const chainLine = `touch: cannot touch ${existingChain}: Read-only file system`;
      expect(writeDenialPlausible(chainLine, ww, { budget: probeBudget() })).toBe(true);
      // the forger's shape: a ten-hop chain that ends INSIDE, so no path short-circuits and all
      // sixteen leaves of all fifty lines are walked from a warm memo. Every step is charged,
      // memo hit or not, so the shared budget is SPENT and the classification stays fast
      // plain hops, no `..`: the only work is memo hits, which must cost like any other step
      for (let i = 0; i < 10; i += 1) {
        const target = i === 9 ? join(root, "x") : join(root, `f${i + 1}`);
        await symlink(target, join(root, `f${i}`));
      }
      const insideChain = Array.from({ length: 16 }, (_, i) => `'${root}/f0/y${i}'`).join(" ");
      const insideLine = `touch: cannot touch ${insideChain}: Read-only file system`;
      const t1 = Date.now();
      const budget = probeBudget();
      for (let i = 0; i < 50; i += 1) expect(writeDenialPlausible(insideLine, ww, { budget })).toBe(false);
      expect(Date.now() - t1).toBeLessThan(1_500);
      expect(budget.remaining).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("the syscall budget is global to one classification: once spent, the rest is judged by string", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-budget-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "agentrig-budget-out-")));
    try {
      await symlink(outside, join(root, "etclink"));
      const ww = { mode: "workspace-write" as const, cwd: root };
      const viaLink = `touch: cannot touch '${root}/etclink/x': Read-only file system`;
      // with budget: the link is followed and the line kept
      expect(writeDenialPlausible(viaLink, ww, { budget: probeBudget() })).toBe(true);
      // budget spent: the string says inside, and inside is dropped — the documented narrowing
      const spent = probeBudget(0);
      expect(writeDenialPlausible(viaLink, ww, { budget: spent })).toBe(false);
      // a budget too small to finish the walk is spent by it and then judges by string
      const tiny = probeBudget(3);
      expect(writeDenialPlausible(viaLink, ww, { budget: tiny })).toBe(false);
      expect(tiny.remaining).toBe(0);
      // an outside string is kept either way
      expect(writeDenialPlausible("touch: cannot touch '/etc/x': Read-only file system", ww, { budget: probeBudget(0) })).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a symlinked policy.cwd names the workspace in both forms, so a string judgement cannot keep an inside line", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-cwdlink-")));
    try {
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "link"));
      const ww = { mode: "workspace-write" as const, cwd: join(root, "link") };
      const deep = `${"d/".repeat(70)}x`;
      // past the depth cap, the path is judged by string — against the literal AND the real cwd
      expect(writeDenialPlausible(`touch: cannot touch '${root}/link/${deep}': Read-only file system`, ww)).toBe(false);
      expect(writeDenialPlausible(`touch: cannot touch '${root}/real/${deep}': Read-only file system`, ww)).toBe(false);
      // and past the budget likewise
      expect(writeDenialPlausible(`touch: cannot touch '${root}/real/a': Read-only file system`, ww, { budget: probeBudget(0) })).toBe(false);
      expect(writeDenialPlausible(`touch: cannot touch '${root}/link/a': Read-only file system`, ww, { budget: probeBudget(0) })).toBe(false);
      // a sibling of the real directory is outside in both forms
      expect(writeDenialPlausible(`touch: cannot touch '${root}/other/a': Read-only file system`, ww)).toBe(true);
      // `..` after a link climbs from the link's TARGET, as the kernel does: `out/../x` with
      // `out -> <outside>` lands beside the outside directory, not inside the workspace
      const outside = await realpath(await mkdtemp(join(tmpdir(), "agentrig-dotdot-")));
      try {
        await symlink(outside, join(root, "real", "out"));
        expect(writeDenialPlausible(`touch: cannot touch '${root}/real/out/../x': Read-only file system`, ww)).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the classifier reads the head and the tail of a huge stderr, never the middle", () => {
    const head = "touch: cannot touch '/etc/head': Read-only file system\n";
    const tail = "\ntouch: cannot touch '/etc/tail': Read-only file system";
    const big = head + "x".repeat(400_000) + tail;
    const seen = classifiable(big);
    expect(seen.length).toBeLessThan(140_000);
    expect(seen.startsWith(head)).toBe(true);
    expect(seen.endsWith(tail)).toBe(true);
    expect(classifiable("small")).toBe("small");
    // the cut lands on a line boundary, so a denial line straddling it is never split into a
    // fragment that names only its inside path
    const filler = "x".repeat(1_000) + "\n";
    const straddle = "Error: EROFS: read-only file system, copyfile '/work/proj/a' -> '/etc/x'\n";
    // the line begins 30 characters before the head cut and ends after it
    const headCase = "x".repeat(64 * 1024 - 31) + "\n" + straddle + filler.repeat(200);
    expect(classifiable(headCase)).toContain(straddle.trim());
    // and one whose middle is exactly where the tail cut would land
    const pre = filler.repeat(70);
    const tailCase = pre + straddle + "y".repeat(64 * 1024 - 30);
    expect(classifiable(tailCase)).toContain(straddle.trim());
  });

  it("a symlink inside the workspace that points outside is outside to the boundary", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-symlink-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "agentrig-outside-")));
    try {
      await symlink(outside, join(root, "etclink"));
      const ww = { mode: "workspace-write" as const, cwd: root };
      // the named path is inside by string; the boundary sees where it leads
      expect(writeDenialPlausible(`touch: cannot touch '${root}/etclink/x': Read-only file system`, ww)).toBe(true);
      // a path under a not-yet-existing inside directory is still inside
      expect(writeDenialPlausible(`touch: cannot touch '${root}/new/dir/x': Read-only file system`, ww)).toBe(false);
      // a DANGLING link inside pointing outside: the write would land outside, so it is outside
      await symlink(join(outside, "newfile"), join(root, "out"));
      expect(writeDenialPlausible(`sh: ${root}/out: Read-only file system`, ww)).toBe(true);
      // an inside link to another inside directory stays inside
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "alias"));
      expect(writeDenialPlausible(`touch: cannot touch '${root}/alias/x': Read-only file system`, ww)).toBe(false);
      // a chain of existing links (inside → inside → outside) resolves to the outside
      await symlink(join(root, "link2"), join(root, "link1"));
      await symlink(outside, join(root, "link2"));
      expect(writeDenialPlausible(`touch: cannot touch '${root}/link1/x': Read-only file system`, ww)).toBe(true);
      // a dangling chain (d1 → d2 → outside/newfile) is followed hop by hop
      await symlink(join(root, "d2"), join(root, "d1"));
      await symlink(join(outside, "newfile"), join(root, "d2"));
      expect(writeDenialPlausible(`sh: ${root}/d1: Read-only file system`, ww)).toBe(true);
      // a dangling link with a RELATIVE target resolves against the link's own directory
      await symlink(join("..", basename(outside), "newfile"), join(root, "rel"));
      expect(writeDenialPlausible(`sh: ${root}/rel: Read-only file system`, ww)).toBe(true);
      // and a relative target that stays inside resolves inside — the link's directory is the
      // base, not the filesystem root
      await mkdir(join(root, "sub"));
      await mkdir(join(root, "x2"));
      await symlink(join("..", "x2"), join(root, "sub", "rel"));
      expect(writeDenialPlausible(`touch: cannot touch '${root}/sub/rel/f': Read-only file system`, ww)).toBe(false);
      // a host link from OUTSIDE into the workspace: seatbelt (host filesystem) resolves it inside
      // and drops the line; docker (only the bind is shared) judges the string and keeps it
      await symlink(root, join(outside, "back"));
      const line = `touch: cannot touch '${outside}/back/x': Read-only file system`;
      expect(writeDenialPlausible(line, ww, { sharedFilesystem: true })).toBe(false);
      expect(writeDenialPlausible(line, ww, { sharedFilesystem: false })).toBe(true);
      expect(writeDenialPlausible(line, ww)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  const dockerRun = async (stderrLine: string, mode: "workspace-write" | "read-only") => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-docker-path-")));
    try {
      const wrapper = join(root, "docker");
      const line = stderrLine.replaceAll("CWD", root);
      // the line rides in an environment variable: no shell expansion of $, backticks or quotes
      await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$AGENTRIG_TEST_STDERR" >&2\nexit 1\n`);
      process.env.AGENTRIG_TEST_STDERR = line;
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
      delete process.env.AGENTRIG_TEST_STDERR;
      await rm(root, { recursive: true, force: true });
    }
  };

  it("docker: a read-only line about a path inside the writable workspace is the command's problem, not a denial", async () => {
    // forged, or a host mount inside cwd that is read-only for its own reasons: either way the
    // container did not produce it, and it must not earn an escalation prompt
    const result = await dockerRun("touch: cannot touch 'CWD/notes.md': Read-only file system", "workspace-write");
    expect(result.output.exitCode).toBe(1);
    expect(result.isError).toBe(true);
    // a relative path is not corroborated (the command may have cd'd first), so the pattern alone
    // decides and it stays a denial — corroboration narrows, never widens
    await expect(dockerRun("touch: cannot touch 'sub/notes.md': Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
    await expect(dockerRun("touch: cannot touch 'notes.md': Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
    // a line with $ and backticks reaches the classifier verbatim
    await expect(dockerRun("sh: cannot create /etc/$HOME/`id`: Read-only file system", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
    // a network denial naming an inside path is not a write denial: the path check never touches it
    await expect(dockerRun("CWD/bin/fetch: network is unreachable", "workspace-write"))
      .rejects.toBeInstanceOf(SandboxDeniedError);
  });

  it("corroboration touches the filesystem for at most fifty distinct matching lines; past that it judges by string", async () => {
    const inside = "touch: cannot touch 'CWD/a': Read-only file system";
    const outside = "touch: cannot touch '/etc/x': Read-only file system";
    // a genuine denial after chatty inside lines is still classified, however late
    const late = [...Array.from({ length: 250 }, () => inside), outside].join("\n");
    await expect(dockerRun(late, "workspace-write")).rejects.toBeInstanceOf(SandboxDeniedError);
    // forty inside-only lines: every one corroborated and dropped — an ordinary failure
    const forty = Array.from({ length: 40 }, () => inside).join("\n");
    expect((await dockerRun(forty, "workspace-write")).output.exitCode).toBe(1);
    // sixty DISTINCT forged inside lines: past the budget they are judged by string alone and
    // still dropped — repetition does not buy a prompt
    const sixty = Array.from({ length: 60 }, (_, i) => `touch: cannot touch 'CWD/a${i}': Read-only file system`).join("\n");
    expect((await dockerRun(sixty, "workspace-write")).output.exitCode).toBe(1);
    // the same line sixty times is one line
    const same = Array.from({ length: 60 }, () => inside).join("\n");
    expect((await dockerRun(same, "workspace-write")).output.exitCode).toBe(1);
    // and a genuine outside denial after sixty distinct inside ones is still classified
    await expect(dockerRun(`${sixty}\n${outside}`, "workspace-write")).rejects.toBeInstanceOf(SandboxDeniedError);
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
        process.env.AGENTRIG_TEST_STDERR = line.replace("CWD", root);
        await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$AGENTRIG_TEST_STDERR" >&2\nexit 1\n`);
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
      // a non-write denial is untouched by the path check, even one naming an inside path
      await expect(run("sandbox-exec: deny(1) network-outbound")).rejects.toBeInstanceOf(SandboxDeniedError);
      await expect(run("sandbox-exec: deny(1) process-exec CWD/bin/x")).rejects.toBeInstanceOf(SandboxDeniedError);
    } finally {
      delete process.env.AGENTRIG_TEST_STDERR;
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
