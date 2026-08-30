import { existsSync } from "node:fs";

/**
 * Which shell the `bash` tool runs a command in, and what syntax to tell the model to write.
 *
 * `spawn(..., { shell: true })` means `/bin/sh` on POSIX and **`cmd.exe`** on Windows. A model
 * writes bash — `ls`, `$VAR`, POSIX quoting — so on Windows every command was being handed to a
 * shell that does not speak it, and the model was never told. Naming the shell is half the fix;
 * telling the model which syntax to write is the other half.
 */

export type ShellFamily = "posix" | "powershell" | "cmd";

export interface ResolvedShell {
  /** Handed to `spawn`'s `shell` option: an absolute path, or a name resolved through PATH. */
  path: string;
  family: ShellFamily;
  /** What the tool description calls it. */
  label: string;
}

export interface ResolveShellOptions {
  /** An explicit choice — a path, or a bare name like `bash`, `pwsh`, `cmd`. */
  shell?: string;
  /** Defaults to `process.platform`. Injected so the Windows candidates are testable off Windows. */
  platform?: NodeJS.Platform;
  /** Defaults to `existsSync`. Injected for the same reason. */
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * The filename, splitting on BOTH separators. `node:path`'s `basename` follows the host platform,
 * so a Windows path parsed on POSIX comes back whole — and this module takes the platform as a
 * parameter precisely so it does not depend on the host's.
 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Syntax family from a shell's filename, since that is all a path tells us. */
export function shellFamily(path: string): ShellFamily {
  const name = baseName(path).replace(/\.exe$/i, "").toLowerCase();
  if (name === "cmd" || name === "command") return "cmd";
  if (name === "powershell" || name === "pwsh") return "powershell";
  // sh, bash, dash, zsh, ash, ksh, busybox — and anything unfamiliar, since a shell that is not
  // one of Windows' two is overwhelmingly likely to take `-c` and POSIX syntax
  return "posix";
}

/** What to tell the model, in the terms it will get wrong otherwise. */
export function syntaxHint(family: ShellFamily): string {
  switch (family) {
    case "posix":
      return "POSIX shell syntax";
    case "powershell":
      return "PowerShell syntax (`Get-ChildItem`, not `ls -la`; `$env:VAR`, not `$VAR`)";
    case "cmd":
      return "cmd.exe syntax (`dir`, not `ls`; `%VAR%`, not `$VAR`; no POSIX tools or quoting)";
  }
}

/** Where Git Bash and PowerShell actually live, in the order worth trying. */
function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const dirs = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA];
  // literal backslashes, not `sep`: these are Windows paths whoever is asking, and `sep` is the
  // host's separator
  const gitBash = [
    ...dirs
      .filter((d): d is string => typeof d === "string" && d !== "")
      .map((d) => `${d}\\Git\\bin\\bash.exe`),
    // the default install location, for an environment that does not set the variables
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ];
  const powershell = [
    `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ];
  return [...gitBash, ...powershell];
}

/**
 * The shell to run commands in.
 *
 * POSIX keeps `/bin/sh`: changing it would silently change what every existing trajectory in
 * every repo means, and `--shell /bin/bash` is there for anyone who wants bashisms. Windows
 * prefers Git Bash, then PowerShell, then `cmd.exe` — in that order because the first speaks what
 * the model writes, the second is at least a real shell, and the third is the status quo that
 * made this a follow-up in the first place.
 */
export function resolveShell(opts: ResolveShellOptions = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const env = opts.env ?? process.env;

  if (opts.shell !== undefined && opts.shell !== "") {
    const path = opts.shell;
    return { path, family: shellFamily(path), label: path };
  }
  if (platform !== "win32") {
    return { path: "/bin/sh", family: "posix", label: "/bin/sh" };
  }
  for (const candidate of windowsCandidates(env)) {
    if (exists(candidate)) {
      return { path: candidate, family: shellFamily(candidate), label: baseName(candidate) };
    }
  }
  const comspec = env.ComSpec ?? "cmd.exe";
  return { path: comspec, family: "cmd", label: baseName(comspec) };
}

/**
 * Rejects an explicit `--shell` that names a path nothing lives at, rather than failing on every
 * command with an ENOENT that names neither the flag nor the file. A bare name (`bash`, `pwsh`)
 * is left to PATH resolution at spawn time, which is the only thing that can resolve it.
 */
export function assertShellExists(shell: string, exists: (p: string) => boolean = existsSync): string {
  const looksLikePath = shell.includes("/") || shell.includes("\\");
  if (looksLikePath && !exists(shell)) {
    throw new Error(`--shell ${JSON.stringify(shell)}: no such file`);
  }
  return shell;
}
