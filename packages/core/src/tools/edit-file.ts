import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { contentHash } from "../session-store.js";
import { resolveIn } from "./shared.js";
import { writeToolFile } from "./sandbox-write.js";

const EditFileInput = z.object({
  path: z.string().min(1).describe("File path, absolute or relative to the working directory"),
  oldText: z.string().min(1).describe("Exact text to replace; must match the file verbatim"),
  newText: z.string().describe("Replacement text"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence; without it oldText must appear exactly once"),
});
type EditFileInput = z.infer<typeof EditFileInput>;

export function editFileTool(): Tool<EditFileInput, { path: string; replacements: number }> {
  return {
    name: "edit_file",
    sandbox: "compatible",
    description:
      "Search-and-replace in a file. oldText must match exactly once unless replaceAll is set.",
    inputSchema: EditFileInput,
    permission: "write",
    paths: (input) => [input.path],
    async execute(input, ctx): Promise<ToolResult<{ path: string; replacements: number }>> {
      const path = resolveIn(ctx.cwd, input.path);
      const rel = relative(ctx.cwd, path) || path;
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        return { output: { path: rel, replacements: 0 }, display: `cannot read ${input.path}: ${(err as Error).message}`, isError: true };
      }
      // The model reads a file through `read_file`, which shows lines without their carriage
      // returns, and writes `oldText` back with plain `\n`. On a CRLF file — every checkout on
      // Windows — a multi-line oldText then matches nothing, and every edit fails with
      // "oldText not found". So when the verbatim match fails, retry with the line endings
      // converted, and convert `newText` the same way so the file keeps the endings it had.
      let oldText = input.oldText;
      let newText = input.newText;
      let count = occurrences(text, oldText);
      if (count === 0) {
        for (const convert of [toCrlf, toLf]) {
          const candidate = convert(oldText);
          if (candidate === oldText) continue;
          const found = occurrences(text, candidate);
          if (found > 0) {
            oldText = candidate;
            newText = convert(newText);
            count = found;
            break;
          }
        }
      }
      if (count === 0) {
        return { output: { path: rel, replacements: 0 }, display: `oldText not found in ${rel}`, isError: true };
      }
      if (count > 1 && !input.replaceAll) {
        return {
          output: { path: rel, replacements: 0 },
          display: `oldText appears ${count} times in ${rel}; provide more context or set replaceAll`,
          isError: true,
        };
      }
      const next = input.replaceAll
        ? text.split(oldText).join(newText)
        : text.replace(oldText, () => newText);
      await writeToolFile(path, next, ctx.signal);
      ctx.emit({ type: "file.changed", path: rel, op: "edit", contentHash: contentHash(next) });
      const replacements = input.replaceAll ? count : 1;
      return {
        output: { path: rel, replacements },
        display: `edited ${rel} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
      };
    },
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every line ending as CRLF, whatever it was. */
function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, "\r\n");
}

/** Every line ending as LF, whatever it was. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
