import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

export class LocalDiffRefusal extends Error {}
export type LocalGit = (args: string[]) => Promise<string>;
export async function gitRevision(git: LocalGit, ref: string): Promise<string> {
  const sha = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new LocalDiffRefusal("diff requires an existing commit");
  return sha;
}

/** Shared read-only capture; caller owns authorization, subprocess bounds and cancellation. */
export async function captureLocalDiff(root: string, git: LocalGit, baseRef?: string, worktree = baseRef === undefined) {
  const top = (await git(["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(top) !== root)
    throw new LocalDiffRefusal("run local review from the canonical repository root; nested cwd cannot authorize parent-file reads");
  const names = await git(["config", "--includes", "--null", "--name-only", "--list"]);
  if (!names.endsWith("\0") || names.split("\0").slice(0, -1).some(name => !/^[A-Za-z][A-Za-z0-9-]*\.[^\x00-\x1f\x7f]{1,1000}$/.test(name)))
    throw new LocalDiffRefusal("read-only review refuses unsupported Git configuration names; no diff or provider was run");
  if (names.split("\0").some(name => /^filter\./i.test(name)))
    throw new LocalDiffRefusal("read-only review refuses Git clean/process filter configuration; use a repository without configured filters. No diff filter or provider was run.");
  const head = await gitRevision(git, "HEAD");
  const base = baseRef === undefined ? head : await gitRevision(git, baseRef);
  const capture = () => git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--no-color", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", base, ...(worktree ? [] : [head]), "--"]);
  const patch = await capture();
  const identity = `${base}..${worktree ? "tracked-worktree" : head} HEAD:${head} sha256:${createHash("sha256").update(patch).digest("hex")}`;
  const coverage = worktree ? "Tracked base-to-worktree changes only; untracked files excluded; binary content is not shown. No tests run."
    : "Resolved base-to-HEAD text changes only; worktree/untracked changes excluded. No tests run.";
  const verify = async () => {
    if (await gitRevision(git, "HEAD") !== head || await capture() !== patch) throw new LocalDiffRefusal("Git state changed during review; result refused");
  };
  await verify();
  return { patch, identity, coverage, verify };
}
