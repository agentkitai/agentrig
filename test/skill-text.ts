import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skills = resolve(root, ".agentrig/skills");

/** Shared instruction fixture reader. Only repository skill text is EOL-normalized;
 * other instruction documents retain their original bytes. The override must
 * point at a copy of the ENTIRE skills tree, never a fallback to the checkout.
 */
export function readSkillText(path: string | URL, _encoding: "utf8" = "utf8", pathApi: Pick<typeof path, "resolve" | "relative" | "isAbsolute"> = { resolve, relative, isAbsolute }): string {
  const absolute = path instanceof URL ? fileURLToPath(path) : pathApi.resolve(root, path);
  const within = pathApi.relative(skills, absolute);
  const isSkill = within !== ".." && !within.startsWith("../") && !within.startsWith("..\\") && !pathApi.isAbsolute(within);
  const override = process.env.AGENTRIG_TEST_SKILLS_ROOT;
  if (isSkill && override !== undefined) {
    if (!override.trim()) throw new Error("AGENTRIG_TEST_SKILLS_ROOT is present but empty");
    // Validate every repository file, not just the skill requested by this test.
    // Do not cache: a removed file must invalidate an already-used proof root.
    for (const entry of readdirSync(skills, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = pathApi.relative(skills, pathApi.resolve(entry.parentPath, entry.name));
      if (!statSync(pathApi.resolve(override, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`incomplete skills override: ${file} in ${pathApi.resolve(override)}`);
    }
  }
  const target = isSkill && override !== undefined ? pathApi.resolve(override, within) : absolute;
  const text = readFileSync(target, "utf8");
  return isSkill ? text.replace(/\r\n?/g, "\n") : text;
}
