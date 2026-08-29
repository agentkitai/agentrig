import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { contentHash } from "../session-store.js";
import { resolveIn } from "./shared.js";

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
    description:
      "Search-and-replace in a file. oldText must match exactly once unless replaceAll is set.",
    inputSchema: EditFileInput,
    permission: "write",
    async execute(input, ctx): Promise<ToolResult<{ path: string; replacements: number }>> {
      const path = resolveIn(ctx.cwd, input.path);
      const rel = relative(ctx.cwd, path) || path;
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        return { output: { path: rel, replacements: 0 }, display: `cannot read ${input.path}: ${(err as Error).message}`, isError: true };
      }
      const count = text.split(input.oldText).length - 1;
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
        ? text.split(input.oldText).join(input.newText)
        : text.replace(input.oldText, () => input.newText);
      await writeFile(path, next, "utf8");
      ctx.emit({ type: "file.changed", path: rel, op: "edit", contentHash: contentHash(next) });
      const replacements = input.replaceAll ? count : 1;
      return {
        output: { path: rel, replacements },
        display: `edited ${rel} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
      };
    },
  };
}
