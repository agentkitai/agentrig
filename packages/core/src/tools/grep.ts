import { glob as fsGlob, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { isExcludedPath } from "./glob.js";
import { resolveIn } from "./shared.js";

const GrepInput = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression to search for"),
  path: z.string().optional().describe("Directory to search in (default: the working directory)"),
  glob: z.string().optional().describe("Only search files matching this glob (default: all files)"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
});
type GrepInput = z.infer<typeof GrepInput>;

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 250;

export function grepTool(): Tool<GrepInput, GrepMatch[]> {
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression; returns path:line: text matches. " +
      "Binary and very large files, node_modules, and .git are skipped.",
    inputSchema: GrepInput,
    permission: "read",
    async execute(input, ctx): Promise<ToolResult<GrepMatch[]>> {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
      } catch (err) {
        return { output: [], display: `invalid regex: ${(err as Error).message}`, isError: true };
      }
      const cwd = resolveIn(ctx.cwd, input.path ?? ".");
      const cwdStat = await stat(cwd).catch(() => null);
      if (!cwdStat?.isDirectory()) {
        return { output: [], display: `not a directory: ${input.path ?? "."}`, isError: true };
      }
      const matches: GrepMatch[] = [];
      let truncated = false;
      files: for await (const p of fsGlob(input.glob ?? "**/*", {
        cwd,
        exclude: (name) => isExcludedPath(String(name)),
      })) {
        const rel = String(p);
        const abs = join(cwd, rel);
        const s = await stat(abs).catch(() => null);
        if (!s?.isFile() || s.size > MAX_FILE_BYTES) continue;
        const text = await readFile(abs, "utf8").catch(() => null);
        if (text === null || text.includes("\0")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break files;
          }
          matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, MAX_LINE_CHARS) });
        }
      }
      matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
      const result: ToolResult<GrepMatch[]> = {
        output: matches,
        display:
          matches.length === 0
            ? `no matches for /${input.pattern}/`
            : matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n"),
      };
      if (truncated) result.truncated = true;
      return result;
    },
  };
}
