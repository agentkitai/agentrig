// Ship-owned wire boundaries; no core runtime imports.
import { createRequire } from "node:module";
const { z } = await import(createRequire(new URL("../../../packages/core/package.json", import.meta.url)).resolve("zod"));
export const FindingIdentities = z.array(z.object({
  heading: z.string().min(1).refine(value => value.trim().length > 0 && !/[\r\n]/u.test(value)),
  url: z.string().url(),
}).strict()).min(1);
export const ReviewEvidenceManifest = z.object({
  receipt: z.string().min(1), output: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const LedgerPull = z.object({ number: z.number().int().positive().safe(), url: z.string().url(), body: z.string() });
export const LedgerComment = z.object({ id: z.number().int().positive().safe(), html_url: z.string().url(), body: z.string() });
export const PullPatch = z.object({ body: z.string().optional() });
