import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashTool,
  builtinTools,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
  type EventPayload,
  type ToolContext,
} from "@agentkitai/agentrig-core";

let root: string;
let emitted: EventPayload[];
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-tools-"));
  emitted = [];
  ctx = { cwd: root, sessionId: "s1", emit: (p) => emitted.push(p), signal: new AbortController().signal };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("builtinTools", () => {
  it("registers the six v1 tools plus update_plan and bash_job", () => {
    expect(builtinTools().map((t) => t.name).sort()).toEqual([
      "bash",
      "bash_job",
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "update_plan",
      "write_file",
    ]);
  });
});

describe("bash", () => {
  it("captures stdout and exit code 0", async () => {
    const r = await bashTool().execute({ command: "echo hello" }, ctx);
    expect(r.display).toContain("hello");
    expect(r.isError).toBeUndefined();
    expect(r.output.exitCode).toBe(0);
  });

  it("flags non-zero exits as errors, output attached", async () => {
    const r = await bashTool().execute({ command: "echo oops >&2; exit 3" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("oops");
    expect(r.display).toContain("exit code 3");
  });

  it("runs in the working directory", async () => {
    await writeFile(join(root, "here.txt"), "x");
    const r = await bashTool().execute({ command: "ls" }, ctx);
    expect(r.display).toContain("here.txt");
  });

  it("timeout kills the whole process group and returns promptly despite surviving children", async () => {
    const t0 = Date.now();
    const r = await bashTool().execute({ command: "echo started; (sleep 30 &); sleep 60", timeoutMs: 500 }, ctx);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.output.timedOut).toBe(true);
    expect(r.display).toContain("started");
    expect(r.display).toContain("timed out");
  }, 10_000);

  it("refuses to start when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await bashTool().execute({ command: "echo nope" }, { ...ctx, signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.display).toContain("aborted");
  });

  it("abort kills a running command promptly", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const r = await bashTool().execute({ command: "sleep 30" }, { ...ctx, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("session aborted");
  }, 10_000);
});

describe("read_file", () => {
  it("returns numbered lines and honors offset/limit", async () => {
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour");
    const r = await readFileTool().execute({ path: "a.txt", offset: 2, limit: 2 }, ctx);
    expect(r.display).toBe("More lines available; continue with offset 4.\n2\ttwo\n3\tthree");
    expect(r.truncated).toBeUndefined();
  });

  it("reports a missing file as an error", async () => {
    const r = await readFileTool().execute({ path: "nope.txt" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("nope.txt");
  });
});

describe("write_file", () => {
  it("creates parents, writes, and emits file.changed create", async () => {
    const r = await writeFileTool().execute({ path: "deep/dir/n.txt", content: "hi" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(root, "deep/dir/n.txt"), "utf8")).toBe("hi");
    expect(emitted).toMatchObject([{ type: "file.changed", path: "deep/dir/n.txt", op: "create" }]);
  });

  it("emits op edit when overwriting", async () => {
    await writeFile(join(root, "x.txt"), "old");
    await writeFileTool().execute({ path: "x.txt", content: "new" }, ctx);
    expect(emitted).toMatchObject([{ type: "file.changed", op: "edit" }]);
  });
});

describe("edit_file", () => {
  beforeEach(() => writeFile(join(root, "e.txt"), "aaa bbb aaa"));

  it("replaces a unique match and emits file.changed", async () => {
    const r = await editFileTool().execute({ path: "e.txt", oldText: "bbb", newText: "ccc" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(root, "e.txt"), "utf8")).toBe("aaa ccc aaa");
    expect(emitted).toMatchObject([{ type: "file.changed", path: "e.txt", op: "edit" }]);
  });

  it("refuses an ambiguous match without replaceAll", async () => {
    const r = await editFileTool().execute({ path: "e.txt", oldText: "aaa", newText: "z" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("2 times");
    expect(emitted).toEqual([]);
  });

  it("replaces every occurrence with replaceAll", async () => {
    await editFileTool().execute({ path: "e.txt", oldText: "aaa", newText: "z", replaceAll: true }, ctx);
    expect(await readFile(join(root, "e.txt"), "utf8")).toBe("z bbb z");
  });

  it("errors when oldText is absent", async () => {
    const r = await editFileTool().execute({ path: "e.txt", oldText: "nope", newText: "z" }, ctx);
    expect(r.isError).toBe(true);
  });
});

/**
 * A process's group id. `ps`, not `/proc`: `/proc` is Linux-only, and the version of this helper
 * that read it returned null on macOS — where every assertion guarded by it was skipped, so the
 * tests passed there without testing anything.
 */
function groupIdOf(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const pgrp = Number(out);
    return out !== "" && Number.isFinite(pgrp) ? pgrp : null;
  } catch {
    return null; // already reaped, or no ps
  }
}

/** `<pid>` then `<pgid>`, as the shell prints them about itself into the command's own stdout. */
function selfIds(stdout: string): { pid: number; pgrp: number } | null {
  const [pidLine, pgidLine] = stdout.trim().split(/\n/);
  const pid = Number(pidLine);
  const pgrp = Number(pgidLine);
  return Number.isFinite(pid) && Number.isFinite(pgrp) ? { pid, pgrp } : null;
}

describe("which shell runs the command", () => {
  it("runs the command in the shell it was given, not the platform default", async () => {
    // `$0` is the shell itself, so this cannot pass unless that shell really ran it
    const sh = await bashTool({ shell: "/bin/sh" }).execute({ command: "echo $0" }, ctx);
    const bash = await bashTool({ shell: "/bin/bash" }).execute({ command: "echo $0" }, ctx);
    expect((sh.output as { stdout: string }).stdout.trim()).toBe("/bin/sh");
    expect((bash.output as { stdout: string }).stdout.trim()).toBe("/bin/bash");
  });

  it("hands the command to the named shell, with -c, whatever that shell is", async () => {
    // A stub shell rather than a real one: comparing bash against /bin/sh only demonstrates
    // anything where /bin/sh is dash. On macOS it is bash in POSIX mode and runs `[[ ]]` happily,
    // so the version of this test that compared them failed there for a reason that had nothing
    // to do with the code under test.
    const stub = join(root, "stub-shell.sh");
    await writeFile(stub, '#!/bin/sh\necho "STUB RAN: $1 $2"\n', "utf8");
    await chmod(stub, 0o755);

    const r = await bashTool({ shell: stub }).execute({ command: "echo hello" }, ctx);
    // proves both that the chosen shell ran it and that it arrived the way a shell expects
    expect((r.output as { stdout: string }).stdout.trim()).toBe("STUB RAN: -c echo hello");
  });

  it("tells the model which shell it is writing for, and in which syntax", () => {
    expect(bashTool({ shell: "/bin/bash" }).description).toContain("/bin/bash");
    expect(bashTool({ shell: "/bin/bash" }).description).toContain("POSIX");

    // a model told nothing writes bash at cmd.exe and is simply wrong
    const onCmd = bashTool({ platform: "win32", shellExists: () => false, env: { ComSpec: "cmd.exe" } });
    expect(onCmd.description).toContain("cmd.exe");
    expect(onCmd.description).toContain("dir");

    const onPwsh = bashTool({ shell: "pwsh" });
    expect(onPwsh.description).toContain("Get-ChildItem");
  });

  it("is still called `bash`, because permission rules and every recorded trajectory name it", () => {
    expect(bashTool({ shell: "pwsh" }).name).toBe("bash");
    expect(bashTool({ shell: "pwsh" }).permission).toBe("exec");
  });

  it("builtinTools passes the choice through to the tool that needs it", () => {
    const tool = builtinTools({ shell: "/bin/bash" }).find((t) => t.name === "bash")!;
    expect(tool.description).toContain("/bin/bash");
  });
});

describe("killing a command's whole tree", () => {
  it("uses taskkill on Windows, and does not detach to get a group it cannot use", async () => {
    const killed: number[] = [];
    let group: number | null = null;
    const tool = bashTool({
      platform: "win32",
      // the shell is held constant so this test is about the kill, not about what runs
      shell: "/bin/sh",
      killTree: (pid) => {
        killed.push(pid);
        // `detached` on Windows means "survive the parent, in a console of its own" — a flashing
        // window per command and a child that outlives the session, with no group to gain
        group = groupIdOf(pid);
        // stand in for taskkill: with no group to signal, killing the pid is all it must do
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      },
    });
    const r = await tool.execute({ command: "sleep 5", timeoutMs: 100 }, ctx);

    // `process.kill(-pid)` throws on Windows, and the old fallback killed only the direct
    // child — so cmd.exe died and whatever it started kept the pipes open past the timeout
    expect(killed).toHaveLength(1);
    if (group !== null) expect(group).not.toBe(killed[0]);
    expect(r.output).toMatchObject({ timedOut: true });
  });

  it("keeps the process group on this platform, where killing one is the point", async () => {
    const killed: number[] = [];
    const tool = bashTool({ killTree: (p) => void killed.push(p) });
    // the shell reports its own stat line before sleeping, so the group is read while it lives
    const r = await tool.execute({ command: "echo $$; ps -o pgid= -p $$; sleep 5", timeoutMs: 400 }, ctx);
    const out = (r.output as { stdout: string }).stdout;

    expect(killed).toEqual([]);
    expect(r.output).toMatchObject({ timedOut: true });
    // asserted, not skipped: reading /proc from inside the command simply failed on macOS, and
    // the `if (shell !== null)` that tolerated it turned the whole check into a no-op there
    const shell = selfIds(out);
    expect(shell, `could not read the shell's own ids from ${JSON.stringify(out)}`).not.toBeNull();
    // the shell is its own group leader, so `kill(-pid)` reaches everything it started
    expect(shell!.pgrp).toBe(shell!.pid);
  });
});

describe("CRLF files (every checkout on Windows)", () => {
  it("read_file shows lines without their carriage returns", async () => {
    await writeFile(join(root, "crlf.md"), "# AgentRig\r\nsecond line\r\n", "utf8");
    const r = await readFileTool().execute({ path: "crlf.md" }, ctx);
    // the model copies what it is shown straight into edit_file's oldText
    expect(r.display).not.toContain("\r");
    expect(r.display).toContain("# AgentRig");
  });

  it("grep matches an anchored pattern that a carriage return would break", async () => {
    await writeFile(join(root, "crlf.txt"), "alpha\r\nbeta\r\n", "utf8");
    const r = await grepTool().execute({ pattern: "alpha$" }, ctx);
    // asserted on the structured output, not the display: "no matches for /alpha$/" contains
    // the word "alpha" too, so a display-substring check passes whether or not it matched
    expect(r.output).toEqual([{ path: "crlf.txt", line: 1, text: "alpha" }]);
  });

  it("edit_file applies a multi-line edit the model wrote with plain newlines", async () => {
    const path = join(root, "crlf.ts");
    await writeFile(path, "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n", "utf8");
    // exactly what a model produces after reading the file: LF, because that is what it was shown
    const r = await editFileTool().execute(
      { path: "crlf.ts", oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;\nconst b = 20;" },
      ctx,
    );

    expect(r.isError).toBeUndefined();
    const after = await readFile(path, "utf8");
    expect(after).toBe("const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n");
    // the file keeps the endings it had — an edit must not rewrite every line of the diff
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it("edit_file applies an edit the model wrote with carriage returns to an LF file", async () => {
    const path = join(root, "lf.ts");
    await writeFile(path, "const a = 1;\nconst b = 2;\n", "utf8");
    const r = await editFileTool().execute(
      { path: "lf.ts", oldText: "const a = 1;\r\nconst b = 2;", newText: "const a = 10;\r\nconst b = 20;" },
      ctx,
    );

    expect(r.isError).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
  });

  it("replaceAll converts every occurrence, not just the one it matched on", async () => {
    const path = join(root, "many.ts");
    await writeFile(path, "x();\r\ny();\r\nx();\r\ny();\r\n", "utf8");
    const r = await editFileTool().execute(
      { path: "many.ts", oldText: "x();\ny();", newText: "z();\nw();", replaceAll: true },
      ctx,
    );

    expect(r.output).toMatchObject({ replacements: 2 });
    expect(await readFile(path, "utf8")).toBe("z();\r\nw();\r\nz();\r\nw();\r\n");
  });

  it("still reports a genuinely absent oldText rather than mangling the file", async () => {
    const path = join(root, "crlf2.ts");
    await writeFile(path, "const a = 1;\r\n", "utf8");
    const r = await editFileTool().execute({ path: "crlf2.ts", oldText: "nothing like this", newText: "x" }, ctx);
    expect(r.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("const a = 1;\r\n");
  });
});

describe("glob", () => {
  it("makes a collection cap visible without claiming an exhaustive result", async () => {
    for (let i = 0; i < 1001; i++) await writeFile(join(root, `match-${i}.txt`), "");
    const r = await globTool().execute({ pattern: "*.txt" }, ctx);
    expect(r.output).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect(r.fullDisplay).toBeUndefined();
    expect(r.display).toContain("Search incomplete: stopped after 1000 matches");
  });

  it("matches patterns and skips node_modules", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "");
    await writeFile(join(root, "top.ts"), "");
    await writeFile(join(root, "node_modules/pkg/b.ts"), "");
    const r = await globTool().execute({ pattern: "**/*.ts" }, ctx);
    expect(r.output).toEqual(["src/a.ts", "top.ts"]);
  });

  it("reports zero matches without error", async () => {
    const r = await globTool().execute({ pattern: "*.zig" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.display).toContain("no files match");
  });

  it("errors on a nonexistent search directory instead of reporting zero matches", async () => {
    const r = await globTool().execute({ pattern: "**/*.ts", path: "no-such-dir" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("not a directory");
  });
});

describe("grep", () => {
  it("finds matches with path:line and respects the glob filter", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "const x = 1;\nfunction go() {}\n");
    await writeFile(join(root, "src/b.md"), "function in prose\n");
    const r = await grepTool().execute({ pattern: "function \\w+", glob: "**/*.ts" }, ctx);
    expect(r.output).toEqual([{ path: "src/a.ts", line: 2, text: "function go() {}" }]);
    expect(r.display).toBe("src/a.ts:2: function go() {}");
  });

  it("supports ignoreCase", async () => {
    await writeFile(join(root, "c.txt"), "Hello\n");
    const miss = await grepTool().execute({ pattern: "hello" }, ctx);
    expect(miss.output).toEqual([]);
    const hit = await grepTool().execute({ pattern: "hello", ignoreCase: true }, ctx);
    expect(hit.output).toHaveLength(1);
  });

  it("flags an invalid regex as an error", async () => {
    const r = await grepTool().execute({ pattern: "(" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("invalid regex");
  });

  it("errors on a nonexistent search path", async () => {
    const r = await grepTool().execute({ pattern: "x", path: "no-such-dir" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("no such file or directory");
  });

  it("searches a single named file — this used to error and burn a turn every session", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/one.ts"), "alpha\nbeta\nalpha again\n");
    await writeFile(join(root, "src/two.ts"), "alpha elsewhere\n");
    const r = await grepTool().execute({ pattern: "alpha", path: "src/one.ts" }, ctx);
    expect(r.isError).not.toBe(true);
    // only the named file is searched, and matches carry the path as the model gave it
    expect(r.output).toEqual([
      { path: "src/one.ts", line: 1, text: "alpha" },
      { path: "src/one.ts", line: 3, text: "alpha again" },
    ]);
  });

  it("ignores the glob filter for a named file, as the schema promises", async () => {
    // a re-applied glob would silently empty the results — the exact silent-skip failure this
    // feature exists to eliminate
    await writeFile(join(root, "d.ts"), "needle one\n" + "pad\n".repeat(300) + "needle ".repeat(40) + "\n");
    const r = await grepTool().execute({ pattern: "needle", path: "d.ts", glob: "*.md" }, ctx);
    expect(r.isError).not.toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.output[0]).toMatchObject({ path: "d.ts", line: 1 });
  });

  it("caps matches in a single-file search and tells the model the search is incomplete", async () => {
    await writeFile(join(root, "many.txt"), "hit\n".repeat(300));
    const r = await grepTool().execute({ pattern: "hit", path: "many.txt" }, ctx);
    expect(r.output).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.display).toContain("Search incomplete: stopped after 200 matches");
  });

  it("reports abbreviated matching lines rather than silently discarding their tails", async () => {
    await writeFile(join(root, "long.txt"), `match ${"x".repeat(300)}TAIL`);
    const r = await grepTool().execute({ pattern: "TAIL", path: "long.txt" }, ctx);
    expect(r.output).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.fullDisplay).toBeUndefined();
    expect(r.display).toContain("1 matching line(s) abbreviated to 250 characters; use read_file for full lines.");
  });

  it("says why a named file cannot be searched instead of silently skipping it", async () => {
    await writeFile(join(root, "bin.dat"), "abc\0def");
    const binary = await grepTool().execute({ pattern: "abc", path: "bin.dat" }, ctx);
    expect(binary.isError).toBe(true);
    expect(binary.display).toContain("not a text file");

    await writeFile(join(root, "big.txt"), "x".repeat(513 * 1024));
    const big = await grepTool().execute({ pattern: "x", path: "big.txt" }, ctx);
    expect(big.isError).toBe(true);
    expect(big.display).toContain("512KB");
  });
});
