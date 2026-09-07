import type { FileDiff } from "@agentkitai/agentrig-core";
import { structuredPatch } from "diff";

const ELISION = "… diff output elided (display limit)";
const MAX_BYTES = 48 * 1024;

/** Source text never contributes terminal instructions, including through a path/header. */
function printable(text: string): string {
  const clean = text.replace(/\t/g, "    ").replace(/\r/g, "␍")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/gu, "�");
  const points = [...clean];
  return points.length > 512 ? `${points.slice(0, 511).join("")}…` : clean;
}

function* excerpts(side: FileDiff["before"], label: string): Generator<string> {
  yield `${label} excerpt [${side.status}]`;
  if (side.status === "unknown") { yield "  (contents unknown)"; return; }
  if (side.text === "") { yield "  (empty)"; return; }
  const lines = side.text.split("\n");
  for (const line of lines.slice(0, 32)) yield `  ${line}`;
  if (lines.length > 32) yield "  … excerpt elided";
}

function* diffLines(diff: FileDiff): Generator<string> {
  const scope = diff.scope === "observed" ? "observed before/after"
    : diff.scope === "proposed-replacement" ? "proposed replacement excerpt (not whole file)"
      : "proposed content (not an observed write)";
  yield `diff ${diff.path} [${scope}]`;
  yield `snapshots: before=${diff.before.status}, after=${diff.after.status}`;
  // Unknown and partial sides cannot establish a complete patch. Never turn their
  // absent contents into an invented deletion or creation.
  if (diff.before.status !== "complete" || diff.after.status !== "complete") {
    yield "Incomplete observation — labelled excerpts, not a complete patch";
    yield* excerpts(diff.before, "before");
    yield* excerpts(diff.after, "after");
    return;
  }
  const patch = structuredPatch("before", "after", diff.before.text, diff.after.text,
    undefined, undefined, { context: 3, maxEditLength: 2000 });
  if (patch === undefined) {
    yield "Comparison limit reached — labelled excerpts, not a minimal patch";
    yield* excerpts(diff.before, "before");
    yield* excerpts(diff.after, "after");
    return;
  }
  if (patch.hunks.length === 0) { yield "(no textual change in captured snapshots)"; return; }
  yield "--- before";
  yield "+++ after";
  for (const hunk of patch.hunks) {
    yield `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    yield* hunk.lines;
  }
}

/** Pure presentation of a validated captured/proposed value: no disk or Git access. */
export function renderFileDiff(diff: FileDiff, options: { color?: boolean } = {}): string {
  const color = options.color === true && process.env.NO_COLOR === undefined;
  const lines: string[] = [];
  let bytes = 0;
  for (const raw of diffLines(diff)) {
    const line = printable(raw);
    const code = line.startsWith("+") ? "32" : line.startsWith("-") ? "31"
      : line.startsWith("@@") ? "36" : undefined;
    const rendered = color && code !== undefined ? `\u001b[${code}m${line}\u001b[0m` : line;
    const size = Buffer.byteLength(rendered) + 1;
    // Reserve one line and enough bytes for a truthful terminal elision marker.
    if (lines.length >= 79 || bytes + size + Buffer.byteLength(ELISION) + 1 > MAX_BYTES) {
      lines.push(ELISION);
      break;
    }
    lines.push(rendered);
    bytes += size;
  }
  return lines.join("\n");
}
