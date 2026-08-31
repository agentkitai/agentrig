import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * What branch the working directory is on, read straight from `.git` — no child process, because
 * this runs on every turn of an interactive session and spawning `git` per keypress-adjacent
 * refresh is how a statusline becomes the slowest thing in the frame. The reads are two tiny
 * files at most.
 *
 * Returns `null` when the directory is not in a git repository (or anything about the layout is
 * unexpected): the statusline simply omits the segment rather than guessing.
 */
export function currentGitBranch(cwd: string): string | null {
  try {
    const gitDir = findGitDir(resolve(cwd));
    if (gitDir === null) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    if (ref !== null) return ref[1]!;
    // detached HEAD: a bare commit id — show enough of it to recognise, labelled as detached
    if (/^[0-9a-f]{40,64}$/.test(head)) return `detached ${head.slice(0, 7)}`;
    return null;
  } catch {
    return null;
  }
}

/** Walks up from `start` to the filesystem root looking for a `.git` directory or gitfile. */
function findGitDir(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, ".git");
    const stat = statSafe(candidate);
    if (stat?.isDirectory() === true) return candidate;
    if (stat?.isFile() === true) {
      // a worktree or submodule: `.git` is a file saying where the real git dir lives
      const text = readFileSync(candidate, "utf8").trim();
      const m = text.match(/^gitdir: (.+)$/m);
      return m === null ? null : resolve(dir, m[1]!);
    }
    if (dirname(dir) === dir) return null;
  }
}

function statSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
