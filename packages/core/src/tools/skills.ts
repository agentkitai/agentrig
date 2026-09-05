import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { AnyTool, ToolContext, ToolResult } from "../tool.js";

/**
 * Skills: markdown instructions a project keeps on disk, listed to the model cheaply and loaded
 * only when it decides one is relevant.
 *
 * The economics are the whole design. A project may have twenty skills of a thousand words each;
 * injecting them all would cost more context than the task. So the system prompt carries only
 * name + description — one line each — and the body is fetched through a tool. That is the same
 * index-first shape as the wiki (PLAN §3.2), for the same reason.
 *
 * Everything here is untrusted input that reaches the system prompt without a model decision, so
 * a name and a description are sanitized and bounded at parse time: a directory name may contain
 * newlines, and a frontmatter description may be a megabyte long. Both were true, and both put
 * attacker-chosen text into every request.
 */

/** What one catalogue line may cost. A description is a hint, not the instructions. */
const MAX_NAME = 80;
const MAX_DESCRIPTION = 200;
/** What the whole catalogue may cost, whatever `maxSkills` allows. Bytes, not UTF-16 units. */
const MAX_INJECTION_BYTES = 8 * 1024;

/**
 * One line, no control characters. `name` and `description` land verbatim in the system prompt,
 * where a newline is enough to forge a second `## Skills` section with entries nobody wrote.
 */
export function sanitizeLine(value: string, max: number): string {
  const flat = value
    // C0/C1 controls: a newline is enough to forge a heading
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    // zero-width and bidi formatting: invisible, and RLO can visually reorder the rest of the line
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // by code point, not code unit: slicing UTF-16 leaves a lone surrogate in the system prompt
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

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

  // sanitized HERE rather than at injection time so the catalogue, the tool's lookup map and
  // the shadowing check all agree on what a skill is called
  const name = sanitizeLine(fm.name ?? fallbackName, MAX_NAME);
  return {
    name: name === "" ? "(unnamed)" : name,
    // a skill with no description is nearly useless — the model picks on descriptions — so say
    // so rather than showing it an empty line it cannot reason about
    description: sanitizeLine(fm.description ?? firstLine(body) ?? "(no description)", MAX_DESCRIPTION),
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
        // lstat, not stat: a symlink is not a skill, whether it is `notes.md -> ~/.ssh/id_rsa`
        // or `<dir>/SKILL.md -> ../../secret`. Following one would put a file the project never
        // contained into the system prompt of every request, with no model decision involved.
        const info = await lstat(path);
        if (!info.isFile() || info.size > maxBytes) continue;
        const skill = parseSkill(await readFile(path, "utf8"), path);
        // first root wins: a project skill shadows a global one of the same name, which is the
        // order a user expects. Keyed case-insensitively because `skillTool` looks up that way —
        // keeping both `Deploy` and `deploy` advertises two skills and serves one body twice.
        const key = skill.name.toLowerCase();
        if (seen.has(key)) {
          // silently dropping a skill makes a catalogue that lies; say which file lost
          opts.onError?.(new Error(`skill ${JSON.stringify(skill.name)} at ${path} is shadowed by an earlier one`));
          continue;
        }
        seen.add(key);
        out.push(skill);
      } catch (err) {
        // a directory with no SKILL.md is not a skill and not an error — `.git`, `node_modules`
        // and every other subdirectory would otherwise produce one report each
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  return out;
}

/** The one-line-each catalogue injected into the system prompt. */
export function skillsInjection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const header = [
    "## Skills",
    "Instructions available for specific kinds of work. Load one with the `skill` tool before",
    "starting a task it covers; the body is not shown here.",
  ];
  // each line is bounded by `parseSkill`, but 100 skills still add up, and this text rides in
  // EVERY request — so the catalogue as a whole has a ceiling too
  const lines: string[] = [];
  let budget = MAX_INJECTION_BYTES;
  let dropped = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${s.description}`;
    // bytes: a cap counted in UTF-16 units lets a CJK catalogue through at ~3x what it claims
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (cost > budget) {
      dropped += 1;
      continue;
    }
    budget -= cost;
    lines.push(line);
  }
  if (dropped > 0) lines.push(`- (${dropped} further skill(s) not listed; ask by name)`);
  return [...header, ...lines].join("\n");
}

const SkillInput = z.object({ name: z.string().min(1).describe("the skill's name, exactly as listed") });

/** Loads one skill body on demand. Reads nothing but the skills already discovered. */
export function skillTool(skills: Skill[]): AnyTool {
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  return {
    name: "skill",
    sandbox: "compatible",
    description: "Load the full instructions for one of the skills listed in the system prompt.",
    inputSchema: SkillInput,
    // reads a file the harness itself chose, from a fixed set — not a path the model supplies,
    // so there is nothing here for a cwdOnly rule to confine
    permission: "read",
    execute: async (input: z.infer<typeof SkillInput>, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      const skill = byName.get(input.name.trim().toLowerCase());
      if (skill === undefined) {
        const known = [...byName.values()].map((s) => s.name).join(", ");
        return {
          output: { found: false },
          display: `no skill named ${JSON.stringify(input.name)}. Available: ${known || "(none)"}`,
          isError: true,
        };
      }
      // the activation record R9 measures against — only successful loads, so a typo'd lookup
      // does not count as a skill "being used"
      ctx.emit({ type: "skill.used", name: skill.name, invokedBy: "model" });
      return { output: { name: skill.name, path: skill.path }, display: skill.body };
    },
  } as AnyTool;
}
