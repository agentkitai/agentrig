import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentRoleFrontmatterV1, AgentRoleName, parseAgentRoleFrontmatter, resolveManifestNames } from "./manifests.js";

export const AgentRole = AgentRoleFrontmatterV1.extend({
  name: AgentRoleName, body: z.string().min(1).refine(body => Buffer.byteLength(body) <= 32_768),
  origin: z.string().min(1).max(4096), hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AgentRole = z.infer<typeof AgentRole>;

/** Validated host inputs become independent snapshots; modifying the caller's array cannot widen them. */
export function snapshotAgentRoles(roles: readonly AgentRole[]): readonly AgentRole[] {
  if (roles.length > 32) throw new Error("too many agent roles");
  const parsed = roles.map(role => AgentRole.parse(role));
  if (new Set(parsed.map(role => role.name)).size !== parsed.length) throw new Error("duplicate agent role name");
  if (Buffer.byteLength(JSON.stringify(parsed)) > 1_048_576) throw new Error("agent role catalogue exceeds bound");
  return Object.freeze(parsed.map(role => Object.freeze({ ...role, tools: Object.freeze([...role.tools]) as unknown as string[] })));
}

/** Caller must establish project trust. No discovery outside this exact conventional root. */
export async function discoverAgentRoles(projectRoot: string, onError?: (error: Error) => void): Promise<readonly AgentRole[]> {
  const root = await realpath(projectRoot);
  const state = join(root, ".agentrig"), directory = join(state, "agents");
  for (const path of [state, directory]) {
    try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("agent role directory must be a regular directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  const entries: string[] = []; let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > 128) throw new Error("agent role directory exceeds entry bound");
    if (entry.name.endsWith(".md")) entries.push(entry.name);
  }
  if (entries.length > 32) throw new Error("too many agent role files");
  let bytes = 0; const roles: AgentRole[] = [];
  for (const file of entries.sort()) {
    if (bytes >= 1_048_576) throw new Error("agent role aggregate exceeds bound");
    const path = join(directory, file), name = file.slice(0, -3);
    try {
      AgentRoleName.parse(name);
      if (await realpath(path) !== path) throw new Error("agent role path is not canonical");
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error("invalid agent role file");
      const handle = await open(path, "r");
      let data: Buffer;
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error("agent role file changed");
        const buffer = Buffer.alloc(Math.min(65_537, 1_048_577 - bytes)); let offset = 0;
        while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
        bytes += offset;
        if (offset > 65_536) throw new Error("agent role file exceeds bound");
        if (bytes > 1_048_576) throw new Error("agent role aggregate exceeds bound");
        if (await realpath(path) !== path) throw new Error("agent role path changed");
        data = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      const parsed = parseAgentRoleFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(data));
      roles.push({ name, ...parsed.fields, body: parsed.body, origin: path, hash: createHash("sha256").update(data).digest("hex") });
    } catch { onError?.(new Error(`agent role ${JSON.stringify(file)} refused: invalid manifest, path or bounds`)); }
  }
  if (bytes > 1_048_576) throw new Error("agent role aggregate exceeds bound");
  const selected = resolveManifestNames(roles.map(role => ({ ...role, path: role.origin, precedence: 0 })), onError);
  return snapshotAgentRoles(selected.map(({ path: _path, precedence: _precedence, ...role }) => role));
}
