import type { AnyTool } from "../tool.js";
import { bashJobTool, JobRegistry } from "./background-jobs.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { updatePlanTool } from "./update-plan.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { configureDiagnostics } from "../diagnostics.js";
import type { DiagnosticsConfig } from "../diagnostics-types.js";
import { webFetchTool } from "./web-fetch.js";
import { askUserTool } from "../question-runtime.js";

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
export { webFetchTool, type WebFetchOutput } from "./web-fetch.js";
export { safeSliceEnd } from "./shared.js";
export { updatePlanTool } from "./update-plan.js";
export { renderPlanAcceptance, renderPlanItems } from "./update-plan.js";
export { subagentTool, SUBAGENT_TOOL, type SubagentOptions } from "./subagent.js";
export * from "./skills.js";

/**
 * The built-ins: bash (with background jobs via bash_job), read_file, edit_file, write_file,
 * glob, grep, update_plan and the separately permissioned web_fetch. `update_plan` is what makes the supervisor's `drift` detector and
 * `force_replan` rung reachable — both were specified against `plan.updated`, which nothing
 * emitted until M6.
 */
export function builtinTools(opts: BuiltinToolOptions = {}): AnyTool[] {
  // one registry per tool set: `bash --background` and `bash_job` must share it, and a subagent's
  // rebuilt tool set gets its own, so a child can never see or kill its parent's jobs
  const jobs = new JobRegistry();
  const tools = [
    bashTool({ ...(opts.shell === undefined ? {} : { shell: opts.shell }), jobs }),
    bashJobTool(jobs),
    readFileTool(),
    editFileTool(),
    writeFileTool(),
    globTool(),
    grepTool(),
    updatePlanTool(),
    webFetchTool(),
  ];
  configureDiagnostics(tools, opts.diagnostics);
  if (opts.questions !== false) tools.push(askUserTool());
  return tools;
}

export interface BuiltinToolOptions {
  /** Unattended heartbeat explicitly disables clarification requests. */
  questions?: boolean;
  diagnostics?: DiagnosticsConfig;
  /** Which shell `bash` runs commands in. Defaults per platform; see `resolveShell`. */
  shell?: string;
}
