import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseSkillFrontmatter } from "../manifests.js";
import type { Skill } from "./skills.js";

/** Discovery is the only composition boundary. References in every fragment are relative to
 * the entry's directory, not to the fragment. Assets are inert paths, never eager tool calls.
 * No metadata is inherited from fragments (in particular, no flags or generated authority).
 */
export async function resolveSkillBundle(skill: Skill, maxBytes: number, entryBytes: number, charge: (bytes: number) => void): Promise<Skill> {
  if (!skill.includes?.length && !skill.assets?.length) return skill;
  const root = resolve(dirname(skill.path));
  let bytes = entryBytes;
  let visits = 0;
  const active = new Set([resolve(skill.path)]);
  const pieces: string[] = [];

  async function regularFile(path: string): Promise<void> {
    // Syntax validation happened at the manifest boundary. Check every component as well:
    // final O_NOFOLLOW alone would still let a symlinked parent escape the bundle.
    const parts = relative(root, path).split(/[/\\]/);
    if (parts.some(part => part === "..") || !parts.length) throw new Error("invalid bundle path");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
        throw new Error("bundle references require regular files and non-symlink directories");
      }
      if (index === parts.length - 1 && info.size > maxBytes) throw new Error("bundle file byte limit exceeded");
    }
  }

  async function include(ref: string, depth: number): Promise<void> {
    if (depth > 16 || ++visits > 64) throw new Error("include depth/count limit exceeded");
    const path = resolve(root, ref);
    if (active.has(path)) throw new Error(`cyclic include: ${ref}`);
    active.add(path);
    await regularFile(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      // Bounded read also catches a growing file; fstat rejects a swapped special file.
      if (!(await handle.stat()).isFile()) throw new Error("include must be a regular file");
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      charge(length);
      bytes += length;
      if (bytes > maxBytes) throw new Error("expanded include byte budget exceeded");
      text = buffer.subarray(0, length).toString("utf8");
    } finally { await handle.close(); }
    const fragment = parseSkillFrontmatter(text);
    if (Object.keys(fragment.fields).some(key => key !== "includes")) {
      throw new Error("include fragments support only includes metadata");
    }
    for (const child of fragment.fields.includes ?? []) await include(child, depth + 1);
    pieces.push(fragment.body.replace(/\r\n/g, "\n").trim());
    active.delete(path);
  }

  try {
    for (const ref of skill.includes ?? []) await include(ref, 1);
    for (const path of skill.assets ?? []) await regularFile(path);
    pieces.push(skill.body);
    if (skill.assets?.length) pieces.push("## Bundled assets (paths only; not executed)\n" + skill.assets.map(path => `- ${JSON.stringify(path)}`).join("\n"));
    const body = pieces.filter(Boolean).join("\n\n");
    if (Buffer.byteLength(body) > maxBytes) throw new Error("expanded bundle byte budget exceeded");
    return { ...skill, body };
  } catch (error) {
    // Deliberately drop ENOENT's code: a missing SKILL.md is ignorable discovery noise,
    // a missing referenced include/asset is an invalid skill and must be reported.
    throw new Error(`bundle includes/assets: ${error instanceof Error ? error.message : String(error)}`);
  }
}
