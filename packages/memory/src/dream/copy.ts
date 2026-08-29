import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * PLAN §1.5: **dreams never modify their input.** A dream produces a *new* store plus a change
 * report, and the default apply mode is review.
 *
 * That is enforced here by construction rather than by discipline: the dream is only ever handed
 * a copy, and `fingerprint()` lets a test prove the original is byte-identical afterwards. A
 * dream that mutated its input would be unreviewable — the thing you are reviewing would already
 * have happened.
 */

export interface DreamWorkspace {
  /** The copy the dream is allowed to write to. */
  outputRoot: string;
  /** Removes the copy. Safe to call twice. */
  dispose(): Promise<void>;
}

/** Copies a wiki into a fresh directory the dream owns. */
export async function copyWiki(sourceRoot: string, destRoot?: string): Promise<DreamWorkspace> {
  const outputRoot = destRoot ?? (await mkdtemp(join(tmpdir(), "agentrig-dream-")));
  await mkdir(outputRoot, { recursive: true });
  await cp(sourceRoot, outputRoot, { recursive: true, force: true, dereference: false });
  return {
    outputRoot,
    dispose: async () => {
      await rm(outputRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A content hash of every file under `root`, path-sorted. Used by tests to assert the input wiki
 * came out of a dream unchanged — the one invariant the whole review workflow depends on.
 */
export async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of await walk(root)) {
    hash.update(rel.split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

/**
 * Swaps a dreamt wiki in for the original (apply mode `auto`), keeping the previous one beside it
 * as `<root>.before-dream-<stamp>` rather than deleting it. A dream is a bulk LLM rewrite of the
 * agent's memory; "undo" has to be a directory rename, not a restore from a report.
 */
export async function applyDream(sourceRoot: string, outputRoot: string, stamp: string): Promise<string> {
  const src = resolve(sourceRoot);
  const out = resolve(outputRoot);
  if (src === out) throw new Error("applyDream: output root is the input root; the dream must write to a copy");
  const backup = `${src}.before-dream-${stamp}`;
  if (await exists(backup)) throw new Error(`applyDream: ${backup} already exists; refusing to overwrite a backup`);

  // copy-then-swap rather than rename-then-rename: the output usually lives in the OS temp dir,
  // which is frequently a different filesystem, and rename() cannot cross one
  const staged = `${src}.dream-staged-${stamp}`;
  await rm(staged, { recursive: true, force: true });
  await cp(out, staged, { recursive: true, force: true, dereference: false });
  const { rename } = await import("node:fs/promises");
  await rename(src, backup);
  try {
    await rename(staged, src);
  } catch (err) {
    // put the original back rather than leaving the agent with no memory at all
    await rename(backup, src).catch(() => {});
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return backup;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
