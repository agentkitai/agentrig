import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BubblewrapSandboxProvider,
  SandboxDeniedError,
  bashTool,
  SandboxMode,
  SandboxUnavailableError,
  SeatbeltSandboxProvider,
  probeNativeSandbox,
  sandboxSpawnInvocation,
  seatbeltProfile,
  throwIfSandboxDenied,
} from "@agentkitai/agentrig-core";

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

describe("native sandbox providers", () => {
  it("builds a deny-network seatbelt profile with writes scoped to an escaped workspace", () => {
    const workspace = "/tmp/a\"project\nname";
    const writable = seatbeltProfile({ mode: "workspace-write", cwd: workspace });
    expect(writable).toContain("(deny default)");
    expect(writable).toContain("(deny network*)");
    expect(writable).toContain("(allow file-read*)");
    expect(writable).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`);

    const readOnly = seatbeltProfile({ mode: "read-only", cwd: workspace });
    expect(readOnly).not.toContain("file-write");
  });

  it("probes seatbelt once before wrapping a command", async () => {
    const probes: Array<{ command: string; args: readonly string[] }> = [];
    const provider = new SeatbeltSandboxProvider({
      command: "/test/sandbox-exec",
      probeRunner: async (command, args) => { probes.push({ command, args }); },
    });
    const prepared = provider.prepare(async () =>
      sandboxSpawnInvocation("/bin/sh", ["-c", "pwd"], "/work/project"), {
      mode: "workspace-write",
      cwd: "/work/project",
    });

    const first = await prepared();
    const second = await prepared();
    expect(probes).toHaveLength(1);
    expect(probes[0]?.command).toBe("/test/sandbox-exec");
    expect(first.command).toBe("/test/sandbox-exec");
    expect(first.sandboxed).toBe(true);
    expect(first.args.slice(-3)).toEqual(["/bin/sh", "-c", "pwd"]);
    expect(second).toEqual(first);
  });

  it("builds a bubblewrap read-only root and only binds cwd writable in workspace-write", async () => {
    const provider = new BubblewrapSandboxProvider({ probeRunner: async () => {} });
    const invocation = async (mode: "read-only" | "workspace-write") => provider.prepare(
      async () => sandboxSpawnInvocation("/bin/sh", ["-c", "echo ok"], "/work/project"),
      { mode, cwd: "/work/project" },
    )();

    const readOnly = await invocation("read-only");
    expect(readOnly.command).toBe("bwrap");
    expect(readOnly.args).toEqual(expect.arrayContaining([
      "--unshare-all", "--ro-bind", "/", "/", "--chdir", "/work/project", "--", "/bin/sh", "-c", "echo ok",
    ]));
    expect(readOnly.args).not.toContain("--bind");

    const writable = await invocation("workspace-write");
    const bind = writable.args.indexOf("--bind");
    expect(writable.args.slice(bind, bind + 3)).toEqual(["--bind", "/work/project", "/work/project"]);
  });

  it("routes the foreground bash process through the native wrapper", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-bwrap-")));
    try {
      const wrapper = join(root, "fake-bwrap");
      await writeFile(wrapper, "#!/bin/sh\necho wrapped-by-bwrap >&2\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n");
      await chmod(wrapper, 0o755);
      const provider = new BubblewrapSandboxProvider({ command: wrapper });
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
      expect(result.output.stderr).toContain("wrapped-by-bwrap");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns a wrapped bash OS denial into SandboxDeniedError", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-deny-")));
    try {
      const wrapper = join(root, "denying-bwrap");
      await writeFile(wrapper, "#!/bin/sh\necho 'read-only file system' >&2\nexit 1\n");
      await chmod(wrapper, 0o755);
      const provider = new BubblewrapSandboxProvider({ command: wrapper, probeRunner: async () => {} });
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

  it("does not probe or wrap mode none", async () => {
    let probes = 0;
    const provider = new BubblewrapSandboxProvider({ probeRunner: async () => { probes += 1; } });
    const result = await provider.prepare(
      async () => sandboxSpawnInvocation("tool", ["arg"], "/work"),
      { mode: "none", cwd: "/work" },
    )();
    expect(probes).toBe(0);
    expect(result).toEqual({ command: "tool", args: ["arg"], sandboxed: false });
  });

  it("fails closed with an actionable install and explicit unsandboxed fallback message", async () => {
    const provider = new BubblewrapSandboxProvider({ probeRunner: async () => { throw new Error("ENOENT"); } });
    const command = provider.prepare(async () => "must not run", { mode: "read-only", cwd: "/work" });
    await expect(command()).rejects.toMatchObject({
      name: "SandboxUnavailableError",
      backend: "bubblewrap",
      message: expect.stringContaining("install bubblewrap"),
    });
    await expect(command()).rejects.toThrow("none provider (unsandboxed fallback)");
    await expect(command()).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("classifies backend-shaped denials only inside the prepared boundary", async () => {
    expect(() => throwIfSandboxDenied("permission denied")).not.toThrow();
    const provider = new SeatbeltSandboxProvider({ probeRunner: async () => {} });
    const command = provider.prepare(async () => {
      throwIfSandboxDenied("sandbox: deny file-write");
    }, { mode: "workspace-write", cwd: "/work" });
    await expect(command()).rejects.toBeInstanceOf(SandboxDeniedError);
  });

  it("does not mislabel a generic child-process permission failure as a bubblewrap denial", async () => {
    const provider = new BubblewrapSandboxProvider({ probeRunner: async () => {} });
    const command = provider.prepare(async () => {
      throwIfSandboxDenied("application says permission denied");
      return "ordinary failure";
    }, { mode: "read-only", cwd: "/work" });
    await expect(command()).resolves.toBe("ordinary failure");
  });

  it("selects and probes only the platform-native backend", async () => {
    const calls: string[] = [];
    const probeRunner = async (command: string) => { calls.push(command); };
    expect(await probeNativeSandbox("darwin", { probeRunner })).toMatchObject({ backend: "seatbelt", available: true });
    expect(await probeNativeSandbox("linux", {
      probeRunner: async (command, args) => {
        calls.push(command);
        expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--ro-bind", "/", "/"]));
      },
    })).toMatchObject({ backend: "bubblewrap", available: true });
    expect(await probeNativeSandbox("win32", { probeRunner })).toMatchObject({ backend: "none", available: false });
    expect(calls).toEqual(["/usr/bin/sandbox-exec", "bwrap"]);
  });
});
