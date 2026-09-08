/**
 * Fixture-environment preflight for the full suite (feel #237).
 *
 * Most of the suite builds fixtures under the effective temporary directory and asserts that they
 * are *not* inside a repository: project-root discovery, trust roots and the checkpointer all read
 * ancestor `.git` markers. When something above that temporary directory carries a `.git` entry —
 * a real repository, a stray file, or a sandbox that synthesizes empty read-only mounts — those
 * fixtures resolve to the marker's directory and dozens of unrelated tests fail with misleading
 * messages. The discovery is fail-closed on purpose and is not adjusted here; this check just says
 * so before the suite runs, so the environment gets fixed instead of the product.
 *
 * `node test/fixture-preflight.mjs` is silent on success (it guards `pnpm test`); `--verbose`
 * prints what it checked (`pnpm test:preflight`). See docs/TESTING.md.
 */
import { lstat as lstatFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The directory itself and every ancestor, ending at the filesystem root. */
export function ancestorDirectories(directory) {
  const chain = [];
  for (let current = resolve(directory); ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) return chain;
  }
}

const kindOf = stats => stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";

/**
 * Look for a `.git` entry beside the temporary directory and each of its ancestors. `lstat` is
 * injectable so the ancestry can be exercised without depending on the host filesystem.
 */
export async function inspectTemporaryRoot(temporaryDirectory, lstat = lstatFile) {
  const probed = ancestorDirectories(temporaryDirectory).map(directory => join(directory, ".git"));
  const markers = [];
  for (const path of probed) {
    try {
      markers.push({ path, kind: kindOf(await lstat(path)) });
    } catch (error) {
      // Absence is the only clean answer. A marker we cannot read is still a marker: reporting it
      // as absent would hand the suite exactly the silent misdiagnosis this check exists to stop.
      if (error?.code !== "ENOENT") markers.push({ path, kind: "unreadable", detail: error?.code ?? String(error) });
    }
  }
  return { temporaryDirectory: resolve(temporaryDirectory), probed, markers };
}

/** The operator-facing explanation, or `undefined` when the ancestry is clean. */
export function preflightFailure(inspection) {
  if (inspection.markers.length === 0) return undefined;
  const found = inspection.markers
    .map(marker => `    ${marker.path} (${marker.detail === undefined ? marker.kind : `${marker.kind}: ${marker.detail}`})`)
    .join("\n");
  return [
    "Fixture preflight failed: the effective temporary directory is inside a Git ancestry.",
    "",
    `  effective temporary directory: ${inspection.temporaryDirectory}`,
    "  ancestor Git markers:",
    found,
    "",
    "The suite builds fixtures under that directory and asserts they are not in a repository.",
    "AgentRig resolves a project root by walking ancestors for .git, so those fixtures resolve to",
    "the marker's directory instead of their own launch directory, and trust-root, checkpoint and",
    "other non-Git assumptions cannot hold here. This is an environment fact, not a product defect:",
    "the fail-closed discovery is correct and is not being taught to ignore .git.",
    "",
    "Do not delete the marker and do not bypass this check. A sandbox that synthesizes these markers",
    "mounts them read-only and they are not yours to remove; a real repository above the temporary",
    "directory is the operator's to move. Run the suite in an execution environment that is genuinely",
    "outside Git — a shell where this check passes, or an independent runner — and record which",
    "environment produced the result. Known sandbox case and invocations: docs/TESTING.md.",
  ].join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inspection = await inspectTemporaryRoot(tmpdir());
  const failure = preflightFailure(inspection);
  if (failure !== undefined) {
    console.error(failure);
    process.exit(1);
  }
  if (process.argv.includes("--verbose")) {
    console.log(`fixture preflight: no ancestor .git above ${inspection.temporaryDirectory} (checked ${inspection.probed.join(", ")})`);
  }
}
