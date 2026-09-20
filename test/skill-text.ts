import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skills = resolve(root, ".agentrig/skills");

/** Shared instruction fixture reader. Only skill text (including generated SKILL.md fixtures) is EOL-normalized;
 * other instruction documents retain their original bytes. The override must
 * point at a copy of the ENTIRE skills tree, never a fallback to the checkout.
 */
export function readSkillText(path: string | URL, _encoding: "utf8" = "utf8"): string {
  const absolute = path instanceof URL ? fileURLToPath(path) : resolve(root, path);
  const within = relative(skills, absolute);
  const isSkill = within !== ".." && !within.startsWith("../") && !within.startsWith("..\\") && !isAbsolute(within);
  const target = isSkill && process.env.AGENTRIG_TEST_SKILLS_ROOT
    ? resolve(process.env.AGENTRIG_TEST_SKILLS_ROOT, within) : absolute;
  const text = readFileSync(target, "utf8");
  return isSkill || basename(absolute) === "SKILL.md" ? text.replace(/\r\n?/g, "\n") : text;
}
