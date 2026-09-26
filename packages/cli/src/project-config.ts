import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readConfigFile, type ConfigReadOptions, type ConfigFile } from "./config.js";
import { resolveProjectBoundary } from "./trust.js";

/** Operator-owned fallback keyed by the canonical checkout, not a remote or display name.
 * This read-only lookup does not grant project trust or permission to run its commands.
 */
export async function projectConfigPath(root: string, home = homedir()): Promise<string> {
  const boundary = await resolveProjectBoundary(root, home);
  if (!boundary.userStateSafe) throw new Error("per-project user config requires a home outside the project");
  let identity = boundary.projectRoot;
  // Linked worktrees keep one operator declaration for the repository. Ask Git,
  // rather than hand-parsing gitdir/commondir or trusting ambient GIT_DIR overrides.
  let marker;
  try { marker = await lstat(join(identity, ".git")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (marker?.isFile()) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const { stdout } = await promisify(execFile)("git", ["-C", identity, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env: { ...env, GIT_TRACE2_EVENT: "0" }, timeout: 5000, maxBuffer: 8192 });
    const common = stdout.trim();
    if (!isAbsolute(common)) throw new Error("Git common directory must be absolute");
    identity = await realpath(common);
    if (!(await resolveProjectBoundary(dirname(identity), home)).userStateSafe) throw new Error("per-project user config requires a home outside the project");
  }
  if (marker?.isDirectory()) identity = await realpath(join(identity, ".git"));
  return join(home, ".agentrig", "projects", createHash("sha256").update(identity).digest("hex"), "config.json");
}
export async function readProjectConfig(root: string, options: ConfigReadOptions = {}): Promise<{ source: string; config: ConfigFile } | undefined> {
  const home = options.home ?? homedir();
  const boundary = await resolveProjectBoundary(root, home);
  const source = join(boundary.projectRoot, ".agentrig", "config.json");
  const committed = await readConfigFile(source, options);
  if (committed !== undefined) return {source, config: committed};
  if (!boundary.userStateSafe) return undefined;
  const local = await projectConfigPath(root, home);
  const config = await readConfigFile(local, options);
  return config === undefined ? undefined : { source: local, config };
}
