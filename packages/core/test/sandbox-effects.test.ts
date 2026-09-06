import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent, DockerSandboxProvider, SeatbeltSandboxProvider, NoneSandboxProvider,
  SessionStore, writeFileTool, editFileTool, type AnyTool, type ModelProvider,
  type SandboxMode, type SandboxProvider, type Decision, subagentTool, type AgentConfig,
} from "@agentkitai/agentrig-core";
import { FileMemoryStore, memoryTools } from "@agentkitai/agentrig-memory";

const exec = promisify(execFile);
let root: string;
let cwd: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-effects-")));
  cwd = join(root, "workspace");
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(tool: AnyTool, input: unknown, mode: SandboxMode, backend: SandboxProvider = new DockerSandboxProvider(), answer?: Decision) {
  let turn = 0;
  let asks = 0;
  const provider: ModelProvider = {
    id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 8192 },
    async *stream() {
      if (turn++ === 0) {
        yield { type: "tool_use", id: "call", name: tool.name, input };
        yield { type: "stop", reason: "tool_use" };
      } else { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; }
    },
  };
  const agent = createAgent({
    provider, store: new SessionStore({ root: join(root, "logs") }), tools: [tool],
    permissions: { async decide() { return "allow"; } }, systemPrompt: "fixture", repoMap: false,
    sandbox: { provider: backend, mode }, budget: { maxTurns: 2 },
    ...(answer === undefined ? {} : { onAsk: async () => { asks++; return answer; } }),
  });
  const session = agent.run("exercise sandbox", { cwd });
  const events = [];
  for await (const e of session.events) events.push(e);
  expect((await session.done).reason).toBe("done");
  return { events, asks };
}

describe("H1 real tool effects", () => {
  it.each(["read-only", "workspace-write"] as const)("blocks file writes outside cwd under %s despite allow-all permissions", async (mode) => {
    const path = join(root, "outside.txt");
    await writeFile(path, "original");
    for (const tool of [writeFileTool(), editFileTool()]) {
      const input = tool.name === "write_file" ? { path, content: "changed" } : { path, oldText: "original", newText: "changed" };
      const { events } = await run(tool, input, mode);
      expect(events.some(e => e.type === "sandbox.denied")).toBe(true);
      expect(events.some(e => e.type === "file.changed")).toBe(false);
      expect(await readFile(path, "utf8")).toBe("original");
    }
  });

  it("blocks read-only writes inside cwd and allows exactly one explicitly approved outside retry", async () => {
    const path = join(cwd, "inside.txt");
    const denied = await run(writeFileTool(), { path, content: "changed" }, "read-only");
    expect(denied.events.some(e => e.type === "sandbox.denied")).toBe(true);
    await expect(readFile(path)).rejects.toThrow();
    const approved = await run(writeFileTool(), { path, content: "changed" }, "read-only", undefined, "allow");
    expect(approved.asks).toBe(1);
    expect(await readFile(path, "utf8")).toBe("changed");
    expect(approved.events.filter(e => e.type === "file.changed")).toHaveLength(1);
  });

  it("does not infer compatibility from a custom tool's builtin name or read permission", async () => {
    let executed = 0;
    const tool: AnyTool = { name: "read_file", description: "unsafe fixture", permission: "read", inputSchema: z.object({}),
      async execute() { executed++; return { output: "ran", display: "ran" }; } };
    expect((await run(tool, {}, "workspace-write")).events.some(e => e.type === "sandbox.denied")).toBe(true);
    expect(executed).toBe(0);
    expect((await run(tool, {}, "workspace-write", undefined, "allow")).asks).toBe(1);
    expect(executed).toBe(1);
  });

  it("blocks actual memory writes until explicitly approved outside the boundary", async () => {
    const store = new FileMemoryStore({ root: join(root, "wiki") });
    const tool = memoryTools({ store }).find(t => t.name === "memory_write")!;
    const input = { type: "concept", slug: "test", body: "- [stated] fixture (session:test)" };
    const denied = await run(tool, input, "workspace-write");
    expect(denied.events.some(e => e.type === "sandbox.denied")).toBe(true);
    expect(await store.read("concepts/test.md")).toBeNull();
    expect((await run(tool, input, "workspace-write", undefined, "allow")).asks).toBe(1);
    expect(await store.read("concepts/test.md")).not.toBeNull();
  });

  it("refuses host hooks at construction rather than silently dropping a permission hook", () => {
    expect(() => createAgent({ sandbox: { provider: new DockerSandboxProvider(), mode: "workspace-write" },
      hooks: [{ point: "pre_tool", handler: () => { throw new Error("must not run"); } }], tools: [],
    } as never)).toThrow("cannot contain host-process hooks");
  });

  it("allows local memory retrieval without outside approval, but gates backend network access", async () => {
    const store = new FileMemoryStore({ root: join(root, "wiki") });
    await store.write("concepts/test.md", { path: "concepts/test.md", frontmatter: {
      type: "concept", slug: "test", aliases: [], sources: [], updated: "2026-09-05", confidence: "medium",
    }, body: "a durable test fact" });
    for (const name of ["memory_read", "memory_search"]) {
      const tool = memoryTools({ store }).find(t => t.name === name)!;
      const result = await run(tool, name === "memory_read" ? { path: "concepts/test.md" } : { query: "durable" }, "workspace-write");
      expect(result.asks).toBe(0);
      expect(result.events.some(e => e.type === "sandbox.denied")).toBe(false);
      expect(result.events.some(e => e.type === "tool.result" && e.ok && e.display.includes("durable"))).toBe(true);
    }
    let recall = false;
    const tool = memoryTools({ store, backend: { id: "fixture", async recall() { recall = true; return []; }, async onIngest() {}, async promote() {} } })
      .find(t => t.name === "memory_search")!;
    expect((await run(tool, { query: "durable" }, "workspace-write")).events.some(e => e.type === "sandbox.denied")).toBe(true);
    expect(recall).toBe(false);
  });

  it("keeps file enforcement active for an SDK provider without a process launcher", async () => {
    const identity: SandboxProvider = { prepare: command => command };
    for (const path of [join(root, "outside"), join(cwd, "inside")]) {
      const result = await run(writeFileTool(), { path, content: "changed" }, "workspace-write", identity);
      expect(result.events.some(e => e.type === "sandbox.denied")).toBe(true);
      await expect(readFile(path)).rejects.toThrow();
    }
  });

  it.each(Array.from({ length: 10 }, (_, i) => i + 1))("leaves the previous target intact when a staged file write is aborted (run %s)", async () => {
    // Controlled slow process transport, not an OS-isolation test. The production broker's
    // exact program runs, with its stdin consumer parked until abort. A stage filename alone
    // was not a readiness barrier: the old injected `sleep` child could still be forking.
    // Signal readiness after mkfifo finishes, then block the shell itself opening the FIFO.
    class SlowTransport extends SeatbeltSandboxProvider {
      protected override wrap(command: string, args: readonly string[]) {
        return { command, args: args.map((arg, i) => i === 1 ? arg.replace('cat > "$t"', 'mkfifo "$t.block"; : > "$t.ready"; read -r parked < "$t.block"; cat > "$t"') : arg) };
      }
    }
    const path = join(cwd, "target.txt");
    await writeFile(path, "original");
    const signal = new AbortController();
    const work = new SlowTransport().prepare(() => writeFileTool().execute({ path, content: "replacement" }, {
      cwd, sessionId: "fixture", signal: signal.signal, emit() {},
    }), { mode: "workspace-write", cwd })();
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    try {
      const deadline = Date.now() + 3000;
      while (!(await readdir(cwd)).some(name => name.startsWith(".agentrig-write-") && name.endsWith(".ready"))) {
        if (Date.now() > deadline) throw new Error("staged writer never became ready");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally { signal.abort(); }
    await rejected;
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("allows a sandbox-inheriting subagent and refuses a child configured without that boundary", async () => {
    const config: AgentConfig = {
      provider: { id: "child", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 8192 },
        async *stream() { yield { type: "text_delta", text: "child finished" }; yield { type: "stop", reason: "end_turn" }; } },
      store: new SessionStore({ root: join(root, "children") }), tools: [],
      permissions: { async decide() { return "allow"; } }, systemPrompt: "fixture", repoMap: false,
      sandbox: { provider: new DockerSandboxProvider(), mode: "workspace-write" },
    };
    const tool = subagentTool({ createAgent, childConfig: () => config });
    const result = await run(tool, { task: "say done" }, "workspace-write");
    expect(result.events.some(e => e.type === "subagent.spawn")).toBe(true);
    expect(result.events.some(e => e.type === "sandbox.denied")).toBe(false);
    config.sandbox = { provider: new NoneSandboxProvider(), mode: "none" };
    const refused = await run(tool, { task: "say done" }, "workspace-write");
    expect(refused.events.some(e => e.type === "sandbox.denied")).toBe(true);
    expect(refused.events.some(e => e.type === "subagent.spawn")).toBe(false);
  });

  it("cannot silently configure none as an enforcing provider", async () => {
    const path = join(root, "outside.txt");
    const { events } = await run(writeFileTool(), { path, content: "changed" }, "workspace-write", new NoneSandboxProvider());
    expect(events.some(e => e.type === "sandbox.denied")).toBe(true);
    await expect(readFile(path)).rejects.toThrow();
  });

  it("denies a dangling relative link through an outside directory without creating a different inside file", async () => {
    const outsideDir = join(root, "outside-dir");
    await mkdir(outsideDir);
    await symlink("../new.txt", join(outsideDir, "dangling"));
    await symlink(outsideDir, join(cwd, "alias-dir"), "dir");
    const result = await run(writeFileTool(), { path: join(cwd, "alias-dir", "dangling"), content: "changed" }, "workspace-write");
    expect(result.events.some(e => e.type === "sandbox.denied")).toBe(true);
    await expect(readFile(join(cwd, "new.txt"))).rejects.toThrow();
    await expect(readFile(join(root, "new.txt"))).rejects.toThrow();
  });

  it("writes exact bytes through the live provider and preserves only contained symlink targets", async (ctx) => {
    const image = process.env.AGENTRIG_DOCKER_TEST_IMAGE ?? "alpine:3.20";
    let backend: SandboxProvider;
    if (process.platform === "linux") {
      try { await exec("docker", ["info"], { timeout: 10_000 }); await exec("docker", ["image", "inspect", image], { timeout: 10_000 }); }
      catch { console.warn("H1 LIVE DOCKER SKIPPED: daemon or pre-existing fixture image unavailable"); ctx.skip(); return; }
      backend = new DockerSandboxProvider({ image });
    } else if (process.platform === "darwin") {
      try { await exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/sh", "-c", "true"]); }
      catch { console.warn("H1 LIVE SEATBELT SKIPPED: nested sandbox unavailable"); ctx.skip(); return; }
      backend = new SeatbeltSandboxProvider();
    } else { ctx.skip(); return; }
    const path = join(cwd, "space ' $x", "file.txt");
    const content = "literal $(touch /tmp/never-execute) `false`\n" + "é\0\r\n".repeat(20000);
    const written = await run(writeFileTool(), { path, content }, "workspace-write", backend);
    expect(written.events.some(e => e.type === "tool.result" && e.ok)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(content);
    await run(editFileTool(), { path, oldText: "literal", newText: "edited" }, "workspace-write", backend);
    expect(await readFile(path, "utf8")).toBe(content.replace("literal", "edited"));
    const alias = join(cwd, "alias.txt");
    await symlink(path, alias);
    await run(editFileTool(), { path: alias, oldText: "edited", newText: "via-link" }, "workspace-write", backend);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(path, "utf8")).toBe(content.replace("literal", "via-link"));
    const future = join(cwd, "new-dir", "future.txt");
    const dangling = join(cwd, "dangling.txt");
    await symlink(future, dangling);
    await run(writeFileTool(), { path: dangling, content: "new target" }, "workspace-write", backend);
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
    expect(await readFile(future, "utf8")).toBe("new target");
    // Absolute paths can contain '..' after an alias: read and write must resolve them alike.
    await mkdir(join(cwd, "deep", "child"), { recursive: true });
    await symlink(join(cwd, "deep", "child"), join(cwd, "dir-alias"), "dir");
    await run(writeFileTool(), { path: `${cwd}/dir-alias/../through-parent.txt`, content: "parent target" }, "workspace-write", backend);
    expect(await readFile(join(cwd, "deep", "through-parent.txt"), "utf8")).toBe("parent target");
    await expect(readFile(join(cwd, "through-parent.txt"))).rejects.toThrow();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "original");
    const hardlink = join(cwd, "hardlink.txt");
    await link(outside, hardlink);
    await run(writeFileTool(), { path: hardlink, content: "replaced" }, "workspace-write", backend);
    expect(await readFile(hardlink, "utf8")).toBe("replaced");
    expect(await readFile(outside, "utf8")).toBe("original");
    const escapeLink = join(cwd, "escape");
    await symlink(root, escapeLink, "dir");
    const blocked = await run(writeFileTool(), { path: join(escapeLink, "outside.txt"), content: "changed" }, "workspace-write", backend);
    expect(blocked.events.some(e => e.type === "sandbox.denied")).toBe(true);
    expect(blocked.events.some(e => e.type === "tool.result" && !e.ok)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("original");
  }, 60_000);
});
