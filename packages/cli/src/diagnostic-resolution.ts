import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { DiagnosticChecker } from "@agentkitai/agentrig-core";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Only implicit defaults use discovery. Trust permits discovery, not execution: the
 * resolved literal command still passes the ordinary permission/sandbox pipeline.
 * Never ascend beyond the trusted project or follow a compiler link outside it.
 */
export async function resolveDefaultDiagnostics(checkers: DiagnosticChecker[], cwd: string,
  trustedProjectRoot?: string): Promise<DiagnosticChecker[]> {
  if (trustedProjectRoot === undefined) return checkers;
  let root: string, directory: string;
  try { root = await realpath(trustedProjectRoot); directory = await realpath(cwd); }
  catch { return checkers; }
  if (!within(root, directory)) return checkers;
  while (true) {
    try {
      const compiler = await realpath(join(directory, "node_modules", "typescript", "bin", "tsc"));
      if (within(root, compiler) && (await stat(compiler)).isFile()) {
        // Invoke the JS entrypoint with this runtime, not .bin/tsc or a .cmd shell
        // shim. This works without npm's PATH injection and is portable to Windows.
        return checkers.map(checker => checker.parser === "tsc" && checker.executable === "tsc"
          ? { ...checker, executable: process.execPath, args: [compiler, ...checker.args] } : checker);
      }
    } catch { /* Missing/unreadable local compiler: retain normal PATH fallback. */ }
    if (directory === root) return checkers;
    directory = dirname(directory);
  }
}
