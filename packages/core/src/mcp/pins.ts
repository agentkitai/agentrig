import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { McpToolSpec, McpCatalog } from "./protocol.js";

const Snapshot = z.object({ version: z.literal(1), tools: z.array(McpToolSpec.strict()).max(256) }).strict();
const CatalogSnapshot = McpCatalog.extend({ version: z.literal(2), identity: z.unknown() }).strict();
const MAX_BYTES = 1024 * 1024;

/** Stable object-key order; array order and all string bytes remain significant. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function mcpDefinitionSnapshot(tools: McpToolSpec[]): string {
  const parsed = Snapshot.parse({ version: 1, tools });
  if (new Set(parsed.tools.map((tool) => tool.name)).size !== parsed.tools.length) {
    throw new Error("MCP tool list contains duplicate names");
  }
  parsed.tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const result = canonical(parsed);
  if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("MCP tool definitions exceed 1 MiB pin limit");
  return result;
}

export function mcpCatalogSnapshot(catalog: McpCatalog, identity: unknown): string {
  const parsed = CatalogSnapshot.parse({ ...catalog, version: 2, identity });
  if (parsed.tools.length + parsed.resources.length + parsed.templates.length + parsed.prompts.length > 256)
    throw new Error("MCP combined definitions exceed 256 entries");
  const lists = [parsed.tools.map(x => x.name), parsed.resources.map(x => x.uri),
    parsed.templates.map(x => x.uriTemplate), parsed.prompts.map(x => x.name)];
  if (lists.some(list => new Set(list).size !== list.length)) throw new Error("MCP duplicate catalog identity");
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  parsed.tools.sort((a,b) => compare(a.name,b.name));
  parsed.resources.sort((a,b) => compare(a.uri,b.uri));
  parsed.templates.sort((a,b) => compare(a.uriTemplate,b.uriTemplate));
  parsed.prompts.sort((a,b) => compare(a.name,b.name));
  const result = canonical(parsed);
  if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("MCP definitions exceed 1 MiB pin limit");
  return result;
}

function entries(snapshot: string): Map<string, unknown> {
  const raw: unknown = JSON.parse(snapshot);
  const old = Snapshot.safeParse(raw);
  if (old.success) return new Map(old.data.tools.map(t => [`tool\0${t.name}`, t]));
  const current = CatalogSnapshot.parse(raw);
  return new Map([
    ...current.tools.map(t => [`tool\0${t.name}`, t] as const),
    ...current.resources.map(t => [`resource\0${t.uri}`, t] as const),
    ...current.templates.map(t => [`template\0${t.uriTemplate}`, t] as const),
    ...current.prompts.map(t => [`prompt\0${t.name}`, t] as const),
    ["server\0identity", current.identity],
  ]);
}

export interface McpDefinitionChange {
  server: string;
  previousHash: string;
  currentHash: string;
  /** Exact before/after definitions, not an interpretation of the server's claims. */
  changes: Array<{ name: string; before?: unknown; after?: unknown }>;
}

export function mcpDefinitionChange(server: string, previous: string, current: string): McpDefinitionChange {
  const before = entries(previous);
  const after = entries(current);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return {
    server,
    previousHash: createHash("sha256").update(previous).digest("hex"),
    currentHash: createHash("sha256").update(current).digest("hex"),
    changes: names.filter((name) => canonical(before.get(name)) !== canonical(after.get(name))).map((name) => ({
      name: name.startsWith("tool\0") ? name.slice(5) : name.replace("\0", ":"), ...(before.has(name) ? { before: before.get(name)! } : {}), ...(after.has(name) ? { after: after.get(name)! } : {}),
    })),
  };
}

/** Trusted host state. Cooperating writers use a short exclusive lock, never held over consent.
 * Missing baseline uses trust-on-first-use; corrupt or busy state fails closed, never resets. */
export class FileMcpPins {
  constructor(readonly root: string, private readonly scope: string) {}

  private path(server: string): string {
    return join(this.root, `${createHash("sha256").update(JSON.stringify([this.scope, server])).digest("hex")}.json`);
  }

  async read(server: string): Promise<string | undefined> {
    try {
      const handle = await open(this.path(server), "r");
      try {
        // Size the allocation to the file rather than to the cap. A pin is typically a few
        // kilobytes and this ran on every tool call, allocating and zeroing 1 MiB each time. The
        // cap itself is unchanged and still hard: `drain` reads one byte past whatever it was
        // given, so an over-length file is still detected rather than silently truncated, and a
        // file that turns out to be larger than its own stat is re-read once at the full cap.
        const drain = async (capacity: number): Promise<{ buffer: Buffer; size: number }> => {
          const buffer = Buffer.alloc(capacity + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, 0 + size);
            if (bytesRead === 0) break;
            size += bytesRead;
          }
          return { buffer, size };
        };
        const stat = await handle.stat();
        if (stat.size > MAX_BYTES) throw new Error("MCP pin file exceeds 1 MiB");
        let { buffer, size } = await drain(Math.min(Number(stat.size), MAX_BYTES));
        // filled its whole buffer with room left under the cap: the file grew, so read it properly
        if (size === buffer.length && buffer.length <= MAX_BYTES) ({ buffer, size } = await drain(MAX_BYTES));
        if (size > MAX_BYTES) throw new Error("MCP pin file exceeds 1 MiB");
        const raw: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
        const old = Snapshot.safeParse(raw);
        if (old.success) return mcpDefinitionSnapshot(old.data.tools);
        const catalog = CatalogSnapshot.parse(raw);
        return mcpCatalogSnapshot(catalog, catalog.identity);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async compareAndSet(server: string, expected: string | undefined, current: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(server);
    const lock = `${path}.lock`;
    // no stale-lock stealing: recovery is an operator decision made with the writers stopped
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`MCP pin state for ${JSON.stringify(server)} is locked by another writer (${lock}). `
        + "This lock is never stolen or expired: stop every process using these pins, confirm none is mid-write, "
        + "then remove that directory by hand. The pin file itself is untouched and no consent has been lost.");
    }
    const temporary = join(lock, randomUUID());
    try {
      const actual = await this.read(server);
      if (actual === current) return;
      if (actual !== expected) throw new Error("MCP baseline changed during review; retry with fresh definitions");
      await writeFile(temporary, current, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await rmdir(lock);
    }
  }
}
