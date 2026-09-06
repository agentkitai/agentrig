import { z } from "zod";

export const DIFF_REVIEW_LIMITS = Object.freeze({ bytes: 16_384, files: 40, hunks: 128, findings: 16 });
export interface DiffLocation { path: string; side: "old" | "new"; line: number }
export interface DiffReviewInput { patch: string; identity: string }
export const DiffReviewSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  findings: z.array(z.object({
    path: z.string().min(1).max(1024), side: z.enum(["old", "new"]),
    line: z.number().int().positive(), severity: z.enum(["high", "medium", "low"]),
    message: z.string().trim().min(1).max(2000),
  }).strict()).max(DIFF_REVIEW_LIMITS.findings),
}).strict();
export type DiffReviewOutput = z.infer<typeof DiffReviewSchema>;

/** A deliberately bounded text-patch dialect. Never silently discard binary/quoted paths. */
export function diffLocations(patch: string): DiffLocation[] {
  if (Buffer.byteLength(patch) > DIFF_REVIEW_LIMITS.bytes) throw new Error("review diff exceeds 16 KiB");
  if (patch === "") return [];
  const locations: DiffLocation[] = [];
  let oldPath: string | undefined, newPath: string | undefined;
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0, files = 0, hunks = 0, fileHunks = 0;
  const path = (value: string, prefix: string): string | undefined => {
    if (value === "/dev/null") return undefined;
    if (!value.startsWith(prefix)) throw new Error("review requires an ordinary unquoted text patch");
    const name = value.slice(prefix.length);
    if (!name || name.length > 1024 || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith("/")
      || name.split("/").some(part => part === ".." || part === "." || part === ""))
      throw new Error("review contains an unsupported path");
    return name;
  };
  const complete = () => {
    if (oldLeft || newLeft) throw new Error("review contains an incomplete hunk");
  };
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (index === lines.length - 1 && line === "") break;
    if (line.startsWith("diff --git ")) {
      complete();
      if (files && fileHunks === 0) throw new Error("review refuses non-text or metadata-only changes");
      if (++files > DIFF_REVIEW_LIMITS.files) throw new Error("review exceeds 40 files");
      oldPath = newPath = undefined; fileHunks = 0;
      continue;
    }
    if (line.startsWith("@@ ")) {
      complete();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (!match || !files || (oldPath === undefined && newPath === undefined)) throw new Error("invalid review hunk");
      oldLine = Number(match[1]); oldLeft = Number(match[2] ?? 1);
      newLine = Number(match[3]); newLeft = Number(match[4] ?? 1);
      if (![oldLine, oldLeft, newLine, newLeft].every(Number.isSafeInteger) || ++hunks > DIFF_REVIEW_LIMITS.hunks)
        throw new Error("review hunk limits exceeded");
      fileHunks++;
      continue;
    }
    if (oldLeft || newLeft) {
      if (line === "\\ No newline at end of file") continue;
      const kind = line[0];
      if (kind !== " " && kind !== "+" && kind !== "-") throw new Error("invalid review hunk content");
      if (kind !== "+") {
        if (!oldLeft-- || !oldPath || oldLine < 1) throw new Error("invalid review old line");
        locations.push({ path: oldPath, side: "old", line: oldLine++ });
      }
      if (kind !== "-") {
        if (!newLeft-- || !newPath || newLine < 1) throw new Error("invalid review new line");
        locations.push({ path: newPath, side: "new", line: newLine++ });
      }
      continue;
    }
    if (line.startsWith("--- ")) { oldPath = path(line.slice(4), "a/"); continue; }
    if (line.startsWith("+++ ")) { newPath = path(line.slice(4), "b/"); continue; }
    if (/^(?:index .* |new file mode |deleted file mode )160000$/.test(line)) throw new Error("review refuses submodule changes");
    if (/^(index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?|new file mode \d+|deleted file mode \d+)$/.test(line)) continue;
    if (line === "\\ No newline at end of file") continue;
    throw new Error("review refuses binary, renamed or unsupported patch content");
  }
  complete();
  if (!files || !fileHunks || !locations.length) throw new Error("review requires complete text changes");
  return locations;
}

export function validateDiffReview(value: unknown, locations: DiffLocation[]): DiffReviewOutput {
  const result = DiffReviewSchema.parse(value);
  const allowed = new Set(locations.map(item => JSON.stringify([item.path, item.side, item.line])));
  for (const finding of result.findings)
    if (!allowed.has(JSON.stringify([finding.path, finding.side, finding.line]))) throw new Error("review finding is outside captured hunks");
  return result;
}
