import { describe, expect, it } from "vitest";
import { assertShellExists, resolveShell, shellFamily, syntaxHint } from "@agentkitai/agentrig-core";

/** Windows env vars, so the candidate list can be exercised from anywhere. */
const WIN_ENV = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("shellFamily", () => {
  it("reads the syntax family off the filename, which is all a path tells us", () => {
    for (const posix of ["/bin/sh", "/bin/bash", "/usr/bin/zsh", GIT_BASH, "bash", "dash"]) {
      expect(shellFamily(posix), posix).toBe("posix");
    }
    for (const ps of [POWERSHELL, "pwsh", "pwsh.exe", "C:\\x\\PowerShell.exe"]) {
      expect(shellFamily(ps), ps).toBe("powershell");
    }
    for (const cmd of ["cmd", "cmd.exe", "C:\\Windows\\system32\\CMD.EXE"]) {
      expect(shellFamily(cmd), cmd).toBe("cmd");
    }
  });

  it("assumes POSIX for anything unfamiliar, since Windows has only two shells to miss", () => {
    expect(shellFamily("/usr/local/bin/fish")).toBe("posix");
  });
});

describe("resolveShell", () => {
  it("keeps /bin/sh on POSIX, so no existing trajectory changes meaning", () => {
    expect(resolveShell({ platform: "linux" })).toEqual({ path: "/bin/sh", family: "posix", label: "/bin/sh" });
    expect(resolveShell({ platform: "darwin" }).path).toBe("/bin/sh");
  });

  it("prefers Git Bash on Windows, because that is what the model writes for", () => {
    const r = resolveShell({ platform: "win32", env: WIN_ENV, exists: (p) => p === GIT_BASH });
    expect(r).toEqual({ path: GIT_BASH, family: "posix", label: "bash.exe" });
  });

  it("falls back to PowerShell when Git Bash is not installed", () => {
    const r = resolveShell({ platform: "win32", env: WIN_ENV, exists: (p) => p === POWERSHELL });
    expect(r.family).toBe("powershell");
    expect(r.path).toBe(POWERSHELL);
  });

  it("falls back to cmd.exe last, which is the status quo it exists to replace", () => {
    const r = resolveShell({ platform: "win32", env: WIN_ENV, exists: () => false });
    expect(r).toEqual({ path: "C:\\Windows\\system32\\cmd.exe", family: "cmd", label: "cmd.exe" });
  });

  it("looks where Git actually installs, not only where the env vars point", () => {
    // an environment that sets none of the variables still finds a default install
    const r = resolveShell({ platform: "win32", env: {}, exists: (p) => p === GIT_BASH });
    expect(r.path).toBe(GIT_BASH);
  });

  it("an explicit choice wins over every default, on any platform", () => {
    expect(resolveShell({ shell: "/bin/bash", platform: "linux" }).path).toBe("/bin/bash");
    const forced = resolveShell({ shell: "pwsh", platform: "win32", env: WIN_ENV, exists: () => true });
    expect(forced).toEqual({ path: "pwsh", family: "powershell", label: "pwsh" });
  });
});

describe("syntaxHint", () => {
  it("says what the model would otherwise get wrong", () => {
    expect(syntaxHint("posix")).toContain("POSIX");
    // the two that bite: a model writes `ls` and `$VAR` regardless
    expect(syntaxHint("powershell")).toContain("Get-ChildItem");
    expect(syntaxHint("cmd")).toContain("dir");
    expect(syntaxHint("cmd")).toContain("%VAR%");
  });
});

describe("assertShellExists", () => {
  it("rejects a path nothing lives at, naming the flag and the file", () => {
    expect(() => assertShellExists("/no/such/shell", () => false)).toThrow(/--shell/);
    expect(() => assertShellExists("/no/such/shell", () => false)).toThrow(/no such file/);
  });

  it("accepts a bare name, which only PATH can resolve", () => {
    expect(assertShellExists("bash", () => false)).toBe("bash");
    expect(assertShellExists("pwsh.exe", () => false)).toBe("pwsh.exe");
  });

  it("accepts a path that does exist", () => {
    expect(assertShellExists("/bin/sh")).toBe("/bin/sh");
  });
});
