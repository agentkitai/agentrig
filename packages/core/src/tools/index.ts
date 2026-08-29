import type { AnyTool } from "../tool.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";

export { bashTool } from "./bash.js";
export { editFileTool } from "./edit-file.js";
export { globTool, isExcludedPath } from "./glob.js";
export { grepTool, type GrepMatch } from "./grep.js";
export { readFileTool } from "./read-file.js";
export { writeFileTool } from "./write-file.js";

/** The six v1 built-ins: bash, read_file, edit_file, write_file, glob, grep. */
export function builtinTools(): AnyTool[] {
  return [bashTool(), readFileTool(), editFileTool(), writeFileTool(), globTool(), grepTool()];
}
