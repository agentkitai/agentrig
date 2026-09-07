import { z } from "zod";

const Snapshot = z.object({ text: z.string().max(65_536), status: z.enum(["complete", "truncated", "unknown"]) });
export const FileDiff = z.object({
  path: z.string().max(4096),
  scope: z.enum(["observed", "proposed-replacement", "proposed-content"]),
  before: Snapshot, after: Snapshot,
});
export type FileDiff = z.infer<typeof FileDiff>;
