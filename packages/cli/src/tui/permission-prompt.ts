import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { CommandPrefixSchema, PermissionGrantSchema, ShellOperationSchema, permissionGrantCoversRequest,
  type PermissionGrantRegistry, type PermissionGrantSpec, type PermissionRequest } from "@agentkitai/agentrig-core";

export const MAX_SCOPE_TEXT = 24_576;
export type ScopeKind = "path" | "argv";
const AbsolutePath = z.string().min(1).max(4096).refine(s => !/[\u0000-\u001f\u007f]/.test(s) && isAbsolute(s));
const PathDraft = z.object({ pathPrefix: AbsolutePath }).strict();
const ArgvDraft = z.object({ commandPrefix: CommandPrefixSchema, cwd: AbsolutePath }).strict();
export const separatePermissionConsent = (req: PermissionRequest): boolean => req.origin === "sandbox-escalation" || req.origin === "mcp-definition-change" || req.origin === "external-input-expansion";

/** Summarize trusted declarations, never claim to have inferred program effects from text/names. */
export function permissionEffectLines(req: PermissionRequest): string[] {
  const lines = [`Declared permission: ${JSON.stringify(req.class)} for ${JSON.stringify(req.tool)}.`,
    req.class === "write" ? "Declared paths may change; undeclared effects are not established." :
    req.class === "exec" ? "Exec may change files and reach the network; effects are not established by argv." :
    req.class === "network" || req.class === "net" ? "Network access requested; destinations and other effects are not established." :
    "Read access declared; this is not proof of read-only behavior or absence of network access.",
    `cwd: ${JSON.stringify(req.cwd)}`];
  if (req.paths === undefined || req.paths.length === 0) lines.push("Declared paths: none; path effects unknown (not an empty effect set).");
  else {
    lines.push("Declared paths (lexical, not OS/symlink containment):");
    let bytes = 0;
    for (const path of req.paths.slice(0, 128)) {
      const line = `  ${JSON.stringify(path)}`;
      bytes += Buffer.byteLength(line);
      if (bytes > 16_384) { lines.push("  [remaining declared paths omitted from summary; scope still checks every path]"); break; }
      lines.push(line);
    }
    if (req.paths.length > 128) lines.push("  [more than 128 paths; scoped approval unavailable]");
  }
  const parsed = ShellOperationSchema.safeParse(req.operation);
  if (parsed.success) lines.push(parsed.data.status === "parsed"
    ? `Literal argv: ${JSON.stringify(parsed.data.argv)}${parsed.data.background ? " (background; no narrow shell grant)" : ""}`
    : `Shell scope unavailable: ${JSON.stringify(parsed.data.reason)}`);
  lines.push("Names, model prose and MCP read-only hints do not establish effects or authority.");
  if (req.origin === "external-input-expansion") lines.push(`Fresh approval required: external/unknown input proposes first ${req.expansionSurface ?? req.class} dispatch${req.sourceOrigin === undefined ? "" : ` from ${JSON.stringify(req.sourceOrigin)}`}. Standing grants do not apply.`);
  if (!separatePermissionConsent(req)) lines.push(`Standing a/d covers ALL future ${JSON.stringify(req.tool)} requests in this live session, any resource/class/cwd. Children currently share that group. Explicit base rules still apply.`);
  return lines;
}

export function initialPermissionScope(req: PermissionRequest): { kind: ScopeKind; text: string } {
  if (separatePermissionConsent(req)) throw new Error("separate consent cannot become a scoped standing grant");
  const parsed = ShellOperationSchema.safeParse(req.operation);
  if (req.operation !== undefined) {
    if (!parsed.success || parsed.data.status !== "parsed" || parsed.data.background) throw new Error("only supported foreground literal argv can be scoped");
    return { kind: "argv", text: JSON.stringify({ commandPrefix: parsed.data.argv, cwd: resolve(req.cwd) }) };
  }
  if (req.paths === undefined || req.paths.length === 0 || req.paths.length > 128) throw new Error("path scope requires 1–128 declared paths");
  return { kind: "path", text: JSON.stringify({ pathPrefix: resolve(req.cwd) }) };
}

export function proposedPermissionGrant(req: PermissionRequest, kind: ScopeKind, text: string, registry: PermissionGrantRegistry): PermissionGrantSpec {
  if (text.length > MAX_SCOPE_TEXT || Buffer.byteLength(text) > MAX_SCOPE_TEXT) throw new Error("scope exceeds 24 KiB");
  if (initialPermissionScope(req).kind !== kind) throw new Error("scope kind does not match this request");
  const value: unknown = JSON.parse(text);
  const path = kind === "path" ? PathDraft.parse(value).pathPrefix : undefined;
  const argv = kind === "argv" ? ArgvDraft.parse(value) : undefined;
  const sessionId = registry.context.sessionId;
  if (sessionId === undefined) throw new Error("no live session for scoped permission");
  const spec: PermissionGrantSpec = { subject: registry.subject, operation: { tool: req.tool, class: req.class,
    ...(argv === undefined ? {} : { commandPrefix: argv.commandPrefix }) },
    resource: path === undefined ? "*" : { kind: "path-prefix", path: resolve(path) },
    constraints: { cwd: resolve(argv?.cwd ?? req.cwd) }, duration: { kind: "session", id: sessionId }, delegable: true, decision: "allow" };
  PermissionGrantSchema.parse({ ...spec, id: "preview", createdAt: 0 });
  if (!permissionGrantCoversRequest(spec, req)) throw new Error("scope does not cover this request; no grant installed");
  return spec;
}
