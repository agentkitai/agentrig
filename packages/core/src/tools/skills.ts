import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { AnyTool, ToolResult } from "../tool.js";

/**
 * Skills: markdown instructions a project keeps on disk, listed to the model cheaply and loaded
 * only when it decides one is relevant.
 *
 * The economics are the whole design. A project may have twenty skills of a thousand words each;
 * injecting them all would cost more context than the task. So the system prompt carries only
 * name + description — one line each — and the body is fetched through a tool. That is the same
 * index-first shape as the wiki (PLAN §3.2), for the same reason.
 */

const Frontmatter = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

export interface Skill {
  /** Directory name, or filename without `.md` — what the model asks for by. */
  name: string;
  /** One line, shown in the system prompt. This is what the model chooses on. */
  description: string;
  path: string;
  body: string;
}

/** `--- ... ---` frontmatter, then the body. Tolerates a file with neither. */
export function parseSkill(text: string, path: string): Skill {
  // `<name>/SKILL.md` is named by its DIRECTORY — the file is a fixed marker, so taking the
  // basename would name every nested skill "SKILL"
  const file = basename(path).replace(/\.md$/i, "");
  const fallbackName = file.toLowerCase() === "skill" ? basename(resolve(path, "..")) : file;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = m === null ? text : text.slice(m[0].length);

  const fields: Record<string, string> = {};
  if (m !== null) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (kv !== null) fields[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  const parsed = Frontmatter.safeParse(fields);
  const fm = parsed.success ? parsed.data : {};

  return {
    name: fm.name ?? fallbackName,
    // a skill with no description is nearly useless — the model picks on descriptions — so say
    // so rather than showing it an empty line it cannot reason about
    description: fm.description ?? firstLine(body) ?? "(no description)",
    path,
    body: body.trim(),
  };
}

function firstLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t !== "") return t.slice(0, 200);
  }
  return undefined;
}

export interface DiscoverOptions {
  /** Directories to scan. Each may hold `<name>.md` or `<name>/SKILL.md`. */
  roots: string[];
  maxSkills?: number;
  maxBytes?: number;
  onError?: (err: Error) => void;
}

/** Finds skills without reading more than it must. */
export async function discoverSkills(opts: DiscoverOptions): Promise<Skill[]> {
  const maxSkills = opts.maxSkills ?? 100;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const out: Skill[] = [];
  const seen = new Set<string>();

  for (const root of opts.roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // a configured directory that does not exist is not an error
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxSkills) return out;
      const path = e.isDirectory() ? join(root, e.name, "SKILL.md") : join(root, e.name);
      if (!e.isDirectory() && !/\.md$/i.test(e.name)) continue;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > maxBytes) continue;
        const skill = parseSkill(await readFile(path, "utf8"), path);
        // first root wins: a project skill shadows a global one of the same name, which is the
        // order a user expects
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        out.push(skill);
      } catch (err) {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  return out;
}

/** The one-line-each catalogue injected into the system prompt. */
export function skillsInjection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "## Skills",
    "Instructions available for specific kinds of work. Load one with the `skill` tool before",
    "starting a task it covers; the body is not shown here.",
    ...lines,
  ].join("\n");
}

const SkillInput = z.object({ name: z.string().min(1).describe("the skill's name, exactly as listed") });

/** Loads one skill body on demand. Reads nothing but the skills already discovered. */
export function skillTool(skills: Skill[]): AnyTool {
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  return {
    name: "skill",
    description: "Load the full instructions for one of the skills listed in the system prompt.",
    inputSchema: SkillInput,
    // reads a file the harness itself chose, from a fixed set — not a path the model supplies,
    // so there is nothing here for a cwdOnly rule to confine
    permission: "read",
    execute: async (input: z.infer<typeof SkillInput>): Promise<ToolResult<unknown>> => {
      const skill = byName.get(input.name.trim().toLowerCase());
      if (skill === undefined) {
        const known = [...byName.values()].map((s) => s.name).join(", ");
        return {
          output: { found: false },
          display: `no skill named ${JSON.stringify(input.name)}. Available: ${known || "(none)"}`,
          isError: true,
        };
      }
      return { output: { name: skill.name, path: skill.path }, display: skill.body };
    },
  } as AnyTool;
}
