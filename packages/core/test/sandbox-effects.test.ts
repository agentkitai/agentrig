import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent, DockerSandboxProvider, SeatbeltSandboxProvider, NoneSandboxProvider,
  SessionStore, writeFileTool, editFileTool, type AnyTool, type ModelProvider,
  type SandboxMode, type SandboxProvider, type Decision,
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
    await run(tool, input, "workspace-write");
    expect(await store.read("concepts/test.md")).toBeNull();
    expect((await run(tool, input, "workspace-write", undefined, "allow")).asks).toBe(1);
    expect(await store.read("concepts/test.md")).not.toBeNull();
  });

  it("refuses host hooks at construction rather than silently dropping a permission hook", () => {
    expect(() => createAgent({ sandbox: { provider: new DockerSandboxProvider(), mode: "workspace-write" },
      hooks: [{ point: "pre_tool", handler: () => { throw new Error("must not run"); } }], tools: [],
    } as never)).toThrow("cannot contain host-process hooks");
  });

  it("cannot silently configure none as an enforcing provider", async () => {
    const path = join(root, "outside.txt");
    const { events } = await run(writeFileTool(), { path, content: "changed" }, "workspace-write", new NoneSandboxProvider());
    expect(events.some(e => e.type === "sandbox.denied")).toBe(true);
    await expect(readFile(path)).rejects.toThrow();
  });

  it("writes exact bytes through the live OS provider and cannot follow a symlink outside", async (ctx) => {
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
    const outside = join(root, "outside.txt");
    await writeFile(outside, "original");
    const link = join(cwd, "escape");
    await symlink(root, link, "dir");
    const blocked = await run(writeFileTool(), { path: join(link, "outside.txt"), content: "changed" }, "workspace-write", backend);
    expect(blocked.events.some(e => e.type === "tool.result" && !e.ok)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("original");
  }, 60_000);
});
