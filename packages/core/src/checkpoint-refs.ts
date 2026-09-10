import { createHash } from "node:crypto";

/** Globally visible GC roots, but a distinct ownership/retention prefix per worktree. */
export function worktreeCheckpointNamespace(canonicalGitDir: string): string {
  return `refs/agentrig/worktrees/${createHash("sha256").update(canonicalGitDir).digest("hex")}`;
}

/** Read old receipts without migrating or rewriting their immutable session log. */
export function checkpointNamespace(ref: string, sessionId: string, turn: number, sealed = false): string | undefined {
  const scoped = /^refs\/agentrig\/worktrees\/[a-f0-9]{64}(?=\/)/.exec(ref)?.[0];
  for (const prefix of [scoped, "refs/agentrig"]) {
    if (prefix === undefined) continue;
    if (ref === `${prefix}/${sessionId}/${sealed ? "sealed/" : ""}${turn}`) return prefix;
  }
  return undefined;
}
