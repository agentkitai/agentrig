import { z } from "zod";

/** Inert routing text, never executable matching or permission policy. */
const TriggerHint = z.string().min(1).max(1024);

export const AgentRoleName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const AgentRoleToolNames = z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(64)
  .refine(names => new Set(names).size === names.length, "duplicate role tool");
/** A separate R5e dialect: these security fields are NOT accepted by skill manifests. */
export const AgentRoleFrontmatterV1 = z.object({
  schema: z.literal("1").optional(),
  tools: AgentRoleToolNames,
  "model-role": z.enum(["main", "supervisor", "memory", "subagents"]).default("subagents"),
  delegable: z.boolean().default(false),
  "max-turns": z.number().int().min(1).max(1000).optional(),
}).strict();

export function parseAgentRoleFrontmatter(text: string): { fields: z.infer<typeof AgentRoleFrontmatterV1>; body: string } {
  if (Buffer.byteLength(text) > 65_536) throw new Error("agent role file exceeds bound");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("agent role requires frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0 || end > 64 || Buffer.byteLength(lines.slice(0, end + 1).join("\n")) > 8192) throw new Error("agent role frontmatter exceeds bound or is incomplete");
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^([a-z][a-z-]*):[ \t]*(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1]!)) throw new Error("invalid or duplicate agent role field");
    const key = match[1]!, value = match[2]!.trim();
    if (key === "tools" || key === "delegable" || key === "max-turns") fields[key] = JSON.parse(value);
    else fields[key] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  const body = lines.slice(end + 1).join("\n");
  if (body.trim() === "" || Buffer.byteLength(body) > 32_768) throw new Error("agent role body is empty or exceeds bound");
  return { fields: AgentRoleFrontmatterV1.parse(fields), body };
}

/** Explicit R6b metadata dialect; string values also conform to Agent Skills metadata. */
export const GeneratedSkillMetadataV1 = z.object({
  "agentrig-schema": z.literal("1"),
  "agentrig-generated": z.literal("true"),
  "agentrig-sessions": z.string().min(1).max(8192),
  "agentrig-page": z.string().min(1).max(1024),
  "agentrig-dream": z.string().min(1).max(128),
  "agentrig-evidence": z.string().regex(/^[a-f0-9]{64}$/),
  "agentrig-content": z.string().regex(/^[a-f0-9]{64}$/),
  locked: z.enum(["true", "false"]),
  "agentrig-trigger": TriggerHint.optional(),
}).strict();

/** Absent schema means the legacy v1 dialect, never latest. Metadata is explicitly versioned. */
export const SkillFrontmatterV1 = z.object({
  schema: z.literal("1").optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
  trigger: TriggerHint.optional(),
  metadata: GeneratedSkillMetadataV1.optional(),
}).strict();

export const ExtensionSurface = z.enum(["hooks", "tools", "commands"]);
export const ExtensionManifestV1 = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  version: z.string().min(1).max(128),
  apiVersion: z.literal(1),
  surfaces: z.array(ExtensionSurface).max(3).refine((items) => new Set(items).size === items.length, "duplicate surface"),
}).strict();

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema),
]));

/** Supported npm metadata is opaque JSON, never interpreted as AgentRig authority. */
export const PackageManifestV1 = z.object({
  name: z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().min(1).max(128),
  agentrig: z.object({ apiVersion: z.literal(1) }).strict(),
  description: z.string().optional(),
  license: z.string().optional(),
  private: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  author: JsonValueSchema.optional(),
  contributors: JsonValueSchema.optional(),
  repository: JsonValueSchema.optional(),
  homepage: z.string().optional(),
  bugs: JsonValueSchema.optional(),
  funding: JsonValueSchema.optional(),
  type: z.enum(["module", "commonjs"]).optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  types: z.string().optional(),
  exports: JsonValueSchema.optional(),
  files: z.array(z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional().refine((scripts) =>
    !scripts || Object.keys(scripts).length === 0, "package scripts are unsupported; remove the scripts field"),
  dependencies: z.record(z.string(), z.string()).optional().refine((value) => !value || Object.keys(value).length === 0, "dependencies are unsupported"),
  optionalDependencies: z.record(z.string(), z.string()).optional().refine((value) => !value || Object.keys(value).length === 0, "optional dependencies are unsupported"),
  bin: z.never().optional(),
}).strict();

/** Call before importing a module, and before committing each registration draft. Not a sandbox. */
export function validateExtensionSurfaces(manifest: unknown, actual: readonly z.infer<typeof ExtensionSurface>[]): z.infer<typeof ExtensionManifestV1> {
  const parsed = ExtensionManifestV1.parse(manifest);
  for (const surface of actual) {
    if (!parsed.surfaces.includes(surface)) throw new Error(`extension ${parsed.name}: undeclared surface ${surface}`);
  }
  return parsed;
}

export interface ManifestCandidate { name: string; path: string; precedence: number }

/** Lower numbers win. A collision at the winning level blocks ALL definitions of that name. */
export function resolveManifestNames<T extends ManifestCandidate>(candidates: readonly T[], onError?: (error: Error) => void): T[] {
  const groups = new Map<string, T[]>();
  for (const item of candidates) {
    if (!Number.isSafeInteger(item.precedence) || item.precedence < 0) throw new Error("invalid manifest precedence");
    const key = item.name.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const selected: T[] = [];
  for (const [name, items] of groups) {
    items.sort((a, b) => a.precedence - b.precedence || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const first = items[0]!;
    const peers = items.filter((item) => item.precedence === first.precedence);
    if (peers.length > 1) {
      onError?.(new Error(`duplicate manifest name ${JSON.stringify(name)} at equal precedence: ${peers.map((item) => item.path).join(", ")}; none loaded`));
    } else selected.push(first);
    for (const item of items.slice(peers.length)) {
      onError?.(new Error(`manifest ${JSON.stringify(name)} at ${item.path} is shadowed by ${first.path}${peers.length > 1 ? " (ambiguous higher precedence)" : ""}`));
    }
  }
  return selected.sort((a, b) => a.precedence - b.precedence || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Bounded YAML subset: legacy flat scalars plus versioned, JSON-quoted metadata strings.
 * Arbitrary YAML, aliases, tags and collections remain unsupported, never silently ignored. */
export function parseSkillFrontmatter(text: string): { fields: z.infer<typeof SkillFrontmatterV1>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*(?:\r?\n|$)/.test(normalized)) return { fields: {}, body: text };
  const lines = normalized.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  if (end < 0) throw new Error("skill frontmatter: missing closing ---");
  const generatedDialect = lines.slice(1, end).some(line => /^metadata:[ \t]*$/.test(line));
  if (generatedDialect && (end > 64 || Buffer.byteLength(lines.slice(0, end + 1).join("\n")) > 16384)) throw new Error("skill frontmatter limit exceeded");
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let metadata: Record<string, string> | undefined;
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (inMetadata && line.startsWith("  ")) {
      const entry = /^  ([A-Za-z_][A-Za-z0-9_-]*): (".*")$/.exec(line);
      if (!entry) throw new Error("skill metadata requires two-space indentation and JSON-quoted string values");
      if (Object.hasOwn(metadata!, entry[1]!)) throw new Error(`skill metadata: duplicate key ${entry[1]}`);
      const value: unknown = JSON.parse(entry[2]!);
      if (typeof value !== "string") throw new Error("skill metadata values must be strings");
      metadata![entry[1]!] = value;
      continue;
    }
    inMetadata = false;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error("skill frontmatter: expected flat key: value; nested maps and lists are unsupported");
    const key = match[1]!;
    if (Object.hasOwn(fields, key)) throw new Error(`skill frontmatter: duplicate key ${key}`);
    if (key === "allowed-tools") throw new Error("AgentRig does not honour allowed-tools; remove it");
    let value = match[2]!.trim();
    if (key === "metadata") {
      if (value !== "") throw new Error("skill metadata requires a versioned nested string map");
      metadata = Object.create(null) as Record<string, string>;
      fields[key] = metadata; inMetadata = true; continue;
    }
    if (value.startsWith('"') && generatedDialect) {
      const scalar: unknown = JSON.parse(value);
      if (typeof scalar !== "string") throw new Error(`skill frontmatter: expected string for ${key}`);
      fields[key] = scalar; continue;
    }
    if (/^["']/.test(value)) {
      const quote = value[0]!;
      if (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote) || value.includes("\\")) {
        throw new Error(`skill frontmatter: unsupported quoted scalar for ${key}`);
      }
      value = value.slice(1, -1);
    } else if (/^[\[\]{}|>&*!%\-?@`]/.test(value) || /^(?:null|true|false|~)$/i.test(value)) {
      throw new Error(`skill frontmatter: unsupported scalar or collection for ${key}`);
    }
    fields[key] = value;
  }
  const parsed = SkillFrontmatterV1.parse(fields);
  if (parsed.trigger !== undefined && parsed.metadata?.["agentrig-trigger"] !== undefined) {
    throw new Error("skill trigger: use one placement only, trigger or metadata.agentrig-trigger");
  }
  if (parsed.metadata !== undefined) {
    z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(parsed.name);
    z.string().min(1).max(1024).parse(parsed.description);
    const sessions: unknown = JSON.parse(parsed.metadata["agentrig-sessions"]);
    z.array(z.string().regex(/^session:[A-Za-z0-9_-]{1,128}$/)).min(2).max(128).parse(sessions);
  }
  return { fields: parsed, body: lines.slice(end + 1).join("\n") };
}
