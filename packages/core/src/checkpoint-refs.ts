/** Git keeps refs/worktree private to each worktree, including the main worktree. */
export const CHECKPOINT_NAMESPACE = "refs/worktree/agentrig";

/** Read old receipts without migrating or rewriting their immutable session log. */
export function checkpointNamespace(ref: string, sessionId: string, turn: number, sealed = false): string | undefined {
  for (const prefix of [CHECKPOINT_NAMESPACE, "refs/agentrig"]) {
    if (ref === `${prefix}/${sessionId}/${sealed ? "sealed/" : ""}${turn}`) return prefix;
  }
  return undefined;
}
