import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "@agentkitai/agentrig-core";

/**
 * The one MCP test that spawns a real process, because process-group reaping cannot be faked.
 * No network; just `/bin/sh` and `sleep`.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentrig-proc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `S`/`R` = alive, `Z` = killed but not yet reaped, `gone` = reaped. */
function state(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!;
  } catch {
    return "gone";
  }
}

const alive = (pid: number): boolean => ["S", "R", "D"].includes(state(pid));

describe("close() reaps the process group, not just the child", () => {
  it("kills a grandchild spawned by a wrapper script", async () => {
    // Real MCP servers are commonly wrappers (`npx`, `uvx`, a shell shim) that spawn the actual
    // server, so signalling one pid orphans the grandchild — the common case, not the exotic one.
    const script = join(dir, "wrapper.sh");
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nexec sleep 30\n`);
    chmodSync(script, 0o755);

    const client = new McpClient({ name: "wrapper", command: "/bin/sh", args: [script], timeoutMs: 200 });
    // the handshake times out — this wrapper speaks no MCP — but the process is running
    await client.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(grandchild), "the grandchild should be running before close()").toBe(true);

    await client.close();

    // poll: a killed process is briefly a zombie, and `kill(pid, 0)` succeeds on a zombie —
    // which is why checking existence rather than liveness reported a false failure
    for (let i = 0; i < 40 && alive(grandchild); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive(grandchild), `grandchild ${grandchild} survived close() (state ${state(grandchild)})`).toBe(false);
  }, 20_000);

  it("close() resolves promptly rather than hanging on a live child", async () => {
    const client = new McpClient({ name: "sleeper", command: "sleep", args: ["30"], timeoutMs: 100 });
    await client.start().catch(() => {});
    const t0 = Date.now();
    await client.close();
    // an unref'd timer let Node exit before it fired, so close() never resolved at all when the
    // event loop was otherwise quiescent
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 20_000);
});
