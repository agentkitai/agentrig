import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/** Override only skill sources for copy-only CRLF probes outside Git ancestry. */
export function instructionSource(path: string): string {
  const prefix = ".agentrig/skills/";
  const source = path.startsWith(prefix) && process.env.AGENTRIG_SKILL_ROOT
    ? resolve(process.env.AGENTRIG_SKILL_ROOT, path.slice(prefix.length)) : resolve(path);
  return readFileSync(source, "utf8").replace(/\r\n/g, "\n");
}
