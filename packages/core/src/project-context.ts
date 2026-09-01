import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ProjectInstructions {
  path: string;
  content: string;
  bytes: number;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const NOT_A_REGULAR_FILE = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"]);

async function readInstructionFile(path: string): Promise<ProjectInstructions | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) return null;

    // lstat rejects an existing symlink; O_NOFOLLOW closes the swap race before open on platforms
    // that support it. Project instructions must be files, not a path that can escape the project.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const data = await handle.readFile();
      return { path, content: data.toString("utf8"), bytes: data.byteLength };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (NOT_A_REGULAR_FILE.has((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Find the nearest project instruction file, preferring the canonical name over its alias. */
export async function discoverProjectInstructions(cwd: string, projectRoot?: string): Promise<ProjectInstructions | null> {
  let directory = resolve(cwd);
  const boundary = projectRoot === undefined ? undefined : resolve(projectRoot);
  while (true) {
    for (const name of INSTRUCTION_FILES) {
      const instructions = await readInstructionFile(join(directory, name));
      if (instructions !== null) return instructions;
    }

    if (boundary !== undefined && directory === boundary) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
