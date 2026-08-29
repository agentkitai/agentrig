import { glob as fsGlob, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { resolveIn } from "./shared.js";

const GlobInput = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. src/**/*.ts"),
  path: z.string().optional().describe("Directory to search in (default: the working directory)"),
});
type GlobInput = z.infer<typeof GlobInput>;

const MAX_MATCHES = 1000;

/** node_modules and .git are never traversed. */
export function isExcludedPath(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === "node_modules" || seg === ".git");
}

export function globTool(): Tool<GlobInput, string[]> {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern, sorted. node_modules and .git are skipped.",
    inputSchema: GlobInput,
    permission: "read",
    paths: (input) => [input.path ?? "."],
    async execute(input, ctx): Promise<ToolResult<string[]>> {
      const cwd = resolveIn(ctx.cwd, input.path ?? ".");
      const s = await stat(cwd).catch(() => null);
      if (!s?.isDirectory()) {
        // distinguish a typo'd path from a genuinely empty result
        return { output: [], display: `not a directory: ${input.path ?? "."}`, isError: true };
      }
      const matches: string[] = [];
      let truncated = false;
      for await (const p of fsGlob(input.pattern, { cwd, exclude: (name) => isExcludedPath(String(name)) })) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push(String(p));
      }
      matches.sort();
      const result: ToolResult<string[]> = {
        output: matches,
        display: matches.length === 0 ? `no files match ${input.pattern}` : matches.join("\n"),
      };
      if (truncated) result.truncated = true;
      return result;
    },
  };
}
