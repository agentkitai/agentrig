import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileDiff } from "./file-diff-types.js";
import type { Tool, ToolContext, ToolResult } from "./tool.js";
import { activeSandboxPolicy } from "./sandbox-providers.js";

const MAX_BYTES = 65_536;
type Snapshot = FileDiff["before"];
const unknown = (): Snapshot => ({ text: "", status: "unknown" });

/** Bounded presentation copy, not a replacement for the original tool input. */
export function fileSnapshot(text: string): Snapshot {
  const prefix = Buffer.from(text.slice(0, MAX_BYTES), "utf8");
  let end = Math.min(prefix.length, MAX_BYTES);
  while (end > 0 && end < prefix.length && (prefix[end]! & 0xc0) === 0x80) end--;
  let value = prefix.subarray(0, end).toString("utf8");
  if (value.includes("\0")) return unknown();
  const lines = value.split("\n");
  if (lines.length > 6000) value = lines.slice(0, 6000).join("\n");
  return { text: value, status: value === text ? "complete" : "truncated" };
}

/** No extra host read while an enforcing sandbox is active. Unknown is honest. */
export async function captureFileBefore(path: string, signal: AbortSignal): Promise<Snapshot> {
  if (activeSandboxPolicy() !== undefined || signal.aborted) return unknown();
  let observedExisting = false;
  try {
    const initial = await lstat(path);
    observedExisting = true;
    if (!initial.isFile() || initial.isSymbolicLink()) return unknown();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.ino !== initial.ino || before.dev !== initial.dev || signal.aborted) return unknown();
      const bytes = Buffer.alloc(MAX_BYTES + 4);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const current = await lstat(path);
      if (signal.aborted || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return unknown();
      let end = Math.min(bytesRead, MAX_BYTES);
      while (end > 0 && end < bytesRead && (bytes[end]! & 0xc0) === 0x80) end--;
      const result = fileSnapshot(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)));
      return result.status === "unknown" ? result : { ...result, status: before.size > end ? "truncated" : result.status };
    } finally { await handle.close(); }
  } catch (error) {
    return !observedExisting && (error as NodeJS.ErrnoException).code === "ENOENT" ? fileSnapshot("") : unknown();
  }
}

const builtins = new WeakMap<object, "edit" | "write">();
const receipts = new WeakMap<object, { context: ToolContext; diff: FileDiff }>();
export function diffBuiltin<T extends Tool<any, any>>(tool: T, kind: "edit" | "write"): T {
  builtins.set(tool, kind);
  return tool;
}
export function proposedFileDiff(tool: Tool, input: unknown): FileDiff | undefined {
  const kind = builtins.get(tool);
  if (kind === undefined) return undefined;
  const value = input as { path: string; oldText: string; newText: string; content: string };
  return { path: value.path.slice(0, 4096), scope: kind === "edit" ? "proposed-replacement" : "proposed-content",
    before: kind === "edit" ? fileSnapshot(value.oldText) : unknown(),
    after: fileSnapshot(kind === "edit" ? value.newText : value.content) };
}
export function stampFileDiff(result: ToolResult, context: ToolContext, path: string, before: Snapshot, after: string): void {
  const diff: FileDiff = { path: path.slice(0, 4096), scope: "observed", before: Object.freeze({ ...before }), after: Object.freeze(fileSnapshot(after)) };
  receipts.set(result, { context, diff: Object.freeze(diff) });
}
export function takeFileDiff(tool: Tool, result: ToolResult, context: ToolContext): FileDiff | undefined {
  const receipt = receipts.get(result);
  receipts.delete(result);
  return builtins.has(tool) && receipt?.context === context ? receipt.diff : undefined;
}
