import { glob as fsGlob, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { isExcludedPath } from "./glob.js";
import { resolveIn } from "./shared.js";

const GrepInput = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression to search for"),
  path: z
    .string()
    .optional()
    .describe("Directory or single file to search (default: the working directory)"),
  glob: z
    .string()
    .optional()
    .describe("Only search files matching this glob (default: all files; ignored when path is a file)"),
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
    sandbox: "compatible",
    description:
      "Search file contents with a regular expression; returns path:line: text matches. " +
      "`path` may be a directory to walk or a single file to search. " +
      "Binary and very large files, node_modules, and .git are skipped.",
    inputSchema: GrepInput,
    permission: "read",
    paths: (input) => [input.path ?? "."],
    async execute(input, ctx): Promise<ToolResult<GrepMatch[]>> {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
      } catch (err) {
        return { output: [], display: `invalid regex: ${(err as Error).message}`, isError: true };
      }
      const target = resolveIn(ctx.cwd, input.path ?? ".");
      const targetStat = await stat(target).catch(() => null);
      if (targetStat === null) {
        return { output: [], display: `no such file or directory: ${input.path ?? "."}`, isError: true };
      }

      const matches: GrepMatch[] = [];
      let truncated = false;
      /** Returns false when the match cap was hit mid-file. */
      const searchFile = (text: string, rel: string): boolean => {
        // `\r?\n`: a trailing carriage return breaks an anchored pattern and shows up in output
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            return false;
          }
          matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, MAX_LINE_CHARS) });
        }
        return true;
      };

      if (targetStat.isFile()) {
        // A named file is searched directly — this used to error "not a directory", and the
        // model burned a turn rediscovering that every single session. Explicitly naming the
        // file is intent, so the walk's exclusions don't apply; the skip rules that exist for
        // the walker's own protection still get an honest message instead of silence.
        if (targetStat.size > MAX_FILE_BYTES) {
          return { output: [], display: `file exceeds the ${MAX_FILE_BYTES / 1024}KB search limit: ${input.path}`, isError: true };
        }
        const text = await readFile(target, "utf8").catch(() => null);
        if (text === null || text.includes("\0")) {
          return { output: [], display: `not a text file: ${input.path}`, isError: true };
        }
        searchFile(text, input.path ?? ".");
      } else if (targetStat.isDirectory()) {
        files: for await (const p of fsGlob(input.glob ?? "**/*", {
          cwd: target,
          exclude: (name) => isExcludedPath(String(name)),
        })) {
          const rel = String(p);
          const abs = join(target, rel);
          const s = await stat(abs).catch(() => null);
          if (!s?.isFile() || s.size > MAX_FILE_BYTES) continue;
          const text = await readFile(abs, "utf8").catch(() => null);
          if (text === null || text.includes("\0")) continue;
          if (!searchFile(text, rel)) break files;
        }
      } else {
        return { output: [], display: `not a file or directory: ${input.path ?? "."}`, isError: true };
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
