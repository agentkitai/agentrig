import type { AnyTool } from "../tool.js";
import { bashJobTool, JobRegistry } from "./background-jobs.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { updatePlanTool } from "./update-plan.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";

export { bashTool, type BashToolOptions } from "./bash.js";
export { bashJobTool, JobRegistry, type BashJobOutput } from "./background-jobs.js";
export {
  assertShellExists,
  resolveShell,
  shellFamily,
  syntaxHint,
  type ResolvedShell,
  type ResolveShellOptions,
  type ShellFamily,
} from "./shell.js";
export { editFileTool } from "./edit-file.js";
export { globTool, isExcludedPath } from "./glob.js";
export { grepTool, type GrepMatch } from "./grep.js";
export { readFileTool } from "./read-file.js";
export {
  outputArtifactMarker,
  outputHandleFromDisplay,
  readOutputTool,
  READ_OUTPUT_TOOL,
} from "./read-output.js";
export { writeFileTool } from "./write-file.js";
export { safeSliceEnd } from "./shared.js";
export { updatePlanTool } from "./update-plan.js";
export { subagentTool, SUBAGENT_TOOL, type SubagentOptions } from "./subagent.js";
export * from "./skills.js";

/**
 * The built-ins: bash (with background jobs via bash_job), read_file, edit_file, write_file,
 * glob, grep, and update_plan. `update_plan` is what makes the supervisor's `drift` detector and
 * `force_replan` rung reachable — both were specified against `plan.updated`, which nothing
 * emitted until M6.
 */
export function builtinTools(opts: BuiltinToolOptions = {}): AnyTool[] {
  // one registry per tool set: `bash --background` and `bash_job` must share it, and a subagent's
  // rebuilt tool set gets its own, so a child can never see or kill its parent's jobs
  const jobs = new JobRegistry();
  return [
    bashTool({ ...(opts.shell === undefined ? {} : { shell: opts.shell }), jobs }),
    bashJobTool(jobs),
    readFileTool(),
    editFileTool(),
    writeFileTool(),
    globTool(),
    grepTool(),
    updatePlanTool(),
  ];
}

export interface BuiltinToolOptions {
  /** Which shell `bash` runs commands in. Defaults per platform; see `resolveShell`. */
  shell?: string;
}
