import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { contentHash } from "../session-store.js";
import { resolveIn } from "./shared.js";

const WriteFileInput = z.object({
  path: z.string().min(1).describe("File path, absolute or relative to the working directory"),
  content: z.string().describe("Full file content; the file is created or overwritten"),
});
type WriteFileInput = z.infer<typeof WriteFileInput>;

export function writeFileTool(): Tool<WriteFileInput, { path: string; bytes: number }> {
  return {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent directories are created.",
    inputSchema: WriteFileInput,
    permission: "write",
    async execute(input, ctx): Promise<ToolResult<{ path: string; bytes: number }>> {
      const path = resolveIn(ctx.cwd, input.path);
      const existed = await stat(path).then(() => true, () => false);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, "utf8");
      const rel = relative(ctx.cwd, path) || path;
      ctx.emit({
        type: "file.changed",
        path: rel,
        op: existed ? "edit" : "create",
        contentHash: contentHash(input.content),
      });
      const bytes = Buffer.byteLength(input.content, "utf8");
      return {
        output: { path: rel, bytes },
        display: `${existed ? "overwrote" : "created"} ${rel} (${bytes} bytes)`,
      };
    },
  };
}
