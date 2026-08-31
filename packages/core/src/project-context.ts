import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ProjectInstructions {
  path: string;
  content: string;
  bytes: number;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Find the nearest project instruction file, preferring the canonical name over its alias. */
export async function discoverProjectInstructions(cwd: string): Promise<ProjectInstructions | null> {
  let directory = resolve(cwd);
  while (true) {
    for (const name of INSTRUCTION_FILES) {
      const path = join(directory, name);
      try {
        const data = await readFile(path);
        return { path, content: data.toString("utf8"), bytes: data.byteLength };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Keep the file body untouched between conspicuous boundaries in the system prompt. */
export function appendProjectInstructions(system: string, instructions: ProjectInstructions): string {
  return `${system}\n\n===== BEGIN PROJECT INSTRUCTIONS (${instructions.path}) =====\n${instructions.content}\n===== END PROJECT INSTRUCTIONS =====`;
}
