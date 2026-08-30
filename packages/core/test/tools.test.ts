import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
  it("registers the six v1 tools plus update_plan", () => {
    expect(builtinTools().map((t) => t.name).sort()).toEqual([
      "bash",
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
    expect(r.display).toBe("2\ttwo\n3\tthree");
    expect(r.truncated).toBe(true);
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
 * A process's group id, read from /proc. `process.getpgid` is not available in every Node build,
 * and this is the only way to see whether `detached` was set from outside the spawn call.
 */
function groupIdOf(pid: number): number | null {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.pgrp ?? null;
  } catch {
    return null; // not Linux, or already reaped
  }
}

/** `pid (comm) state ppid pgrp ...` — comm can itself contain spaces and parentheses. */
function parseStat(stat: string): { pid: number; pgrp: number } | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const pid = Number(stat.slice(0, stat.indexOf(" ")));
  const pgrp = Number(stat.slice(close + 2).split(" ")[2]);
  return Number.isFinite(pid) && Number.isFinite(pgrp) ? { pid, pgrp } : null;
}

describe("killing a command's whole tree", () => {
  it("uses taskkill on Windows, and does not detach to get a group it cannot use", async () => {
    const killed: number[] = [];
    let group: number | null = null;
    const tool = bashTool({
      platform: "win32",
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
    const r = await tool.execute({ command: "cat /proc/$$/stat; sleep 5", timeoutMs: 300 }, ctx);
    const out = (r.output as { stdout: string }).stdout;

    expect(killed).toEqual([]);
    expect(r.output).toMatchObject({ timedOut: true });
    const shell = parseStat(out);
    // the shell is its own group leader, so `kill(-pid)` reaches everything it started
    if (shell !== null) expect(shell.pgrp).toBe(shell.pid);
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

  it("errors on a nonexistent search directory", async () => {
    const r = await grepTool().execute({ pattern: "x", path: "no-such-dir" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("not a directory");
  });
});
