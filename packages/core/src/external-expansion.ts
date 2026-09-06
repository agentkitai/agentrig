import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ContentBlock } from "./messages.js";
import type { PermissionRequest } from "./events.js";
import { writeTarget } from "./tools/sandbox-write.js";

export type ExpansionSurface = "exec" | "network" | "write-outside-cwd";

/** Runtime state only: neither persisted labels nor model roles can mint fresh user input. */
export function externalExpansion() {
  let restricted = true;
  let pendingUser = false;
  let pendingExternal = false;
  let requestHasUser = false;
  const used = new Set<ExpansionSurface>();
  return {
    user(text: string) { if (text.trim() !== "") pendingUser = true; },
    unknown() { pendingExternal = true; },
    input(blocks: readonly ContentBlock[]) {
      let remaining = 4096;
      const unknown = (values: readonly ContentBlock[], depth = 0): boolean => {
        if (depth > 32) return true;
        for (const block of values) {
          if (--remaining < 0 || (block.trust !== "user" && block.trust !== "project")) return true;
          if (block.type === "tool_result" && Array.isArray(block.content) && unknown(block.content, depth + 1)) return true;
        }
        return false;
      };
      if (unknown(blocks)) pendingExternal = true;
    },
    beginRequest() {
      requestHasUser = pendingUser;
      if (pendingUser) restricted = false;
      else if (pendingExternal) restricted = true;
      pendingUser = false; pendingExternal = false;
    },
    /** A pre-tool merge can introduce advisory input after the model request was assembled. */
    hookInput() { if (!requestHasUser) restricted = true; },
    needs(surface: ExpansionSurface | undefined) { return surface !== undefined && restricted && !used.has(surface); },
    dispatched(surface: ExpansionSurface | undefined) { if (surface !== undefined) used.add(surface); },
  };
}

/** Declared-path classification, not effect attestation. Unknown is outside for this guard. */
export async function expansionSurface(req: PermissionRequest, signal: AbortSignal): Promise<ExpansionSurface | undefined> {
  if (req.class === "exec" || req.class === "network") return req.class;
  if (req.class !== "write") return undefined;
  const paths = req.paths;
  if (paths === undefined || paths.length === 0 || paths.length > 32) return "write-outside-cwd";
  try {
    signal.throwIfAborted();
    const cwd = await realpath(req.cwd);
    for (const path of paths) {
      if (path.length === 0 || path.length > 4096) return "write-outside-cwd";
      signal.throwIfAborted();
      const target = await writeTarget(isAbsolute(path) ? path : `${req.cwd}${sep}${path}`);
      const rel = relative(cwd, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "write-outside-cwd";
    }
    return undefined;
  } catch { return "write-outside-cwd"; }
}
