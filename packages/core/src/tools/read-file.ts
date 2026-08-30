import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { bound, resolveIn } from "./shared.js";

const ReadFileInput = z.object({
  path: z.string().min(1).describe("File path, absolute or relative to the working directory"),
  offset: z.number().int().positive().optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to return"),
});
type ReadFileInput = z.infer<typeof ReadFileInput>;

export function readFileTool(): Tool<ReadFileInput, string> {
  return {
    name: "read_file",
    description:
      "Read a text file. Returns numbered lines; use offset/limit to page through large files.",
    inputSchema: ReadFileInput,
    permission: "read",
    paths: (input) => [input.path],
    async execute(input, ctx): Promise<ToolResult<string>> {
      const path = resolveIn(ctx.cwd, input.path);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        return { output: "", display: `cannot read ${input.path}: ${(err as Error).message}`, isError: true };
      }
      // `\r?\n`, not `\n`: on a CRLF file every line would otherwise reach the model with a
      // trailing carriage return, which it then copies into `edit_file`'s oldText
      const lines = text.split(/\r?\n/);
      const start = (input.offset ?? 1) - 1;
      const slice = lines.slice(start, input.limit === undefined ? undefined : start + input.limit);
      const width = String(start + slice.length).length;
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(width)}\t${l}`).join("\n");
      const { display, truncated } = bound(numbered);
      const result: ToolResult<string> = { output: text, display };
      if (truncated || input.limit !== undefined && start + slice.length < lines.length) result.truncated = true;
      return result;
    },
  };
}
