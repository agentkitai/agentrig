import { z } from "zod";

/** Flat frontmatter only. Absent schema means the legacy v1 dialect, never latest. */
export const SkillFrontmatterV1 = z.object({
  schema: z.literal("1").optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
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

/** Deliberately not YAML: reject constructs this scanner cannot faithfully represent. */
export function parseSkillFrontmatter(text: string): { fields: z.infer<typeof SkillFrontmatterV1>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*(?:\r?\n|$)/.test(normalized)) return { fields: {}, body: text };
  const lines = normalized.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  if (end < 0) throw new Error("skill frontmatter: missing closing ---");
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error("skill frontmatter: expected flat key: value; nested maps and lists are unsupported");
    const key = match[1]!;
    if (Object.hasOwn(fields, key)) throw new Error(`skill frontmatter: duplicate key ${key}`);
    if (key === "allowed-tools") throw new Error("AgentRig does not honour allowed-tools; remove it");
    let value = match[2]!.trim();
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
  return { fields: SkillFrontmatterV1.parse(fields), body: lines.slice(end + 1).join("\n") };
}
