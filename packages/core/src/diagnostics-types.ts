import { z } from "zod";

const literal = z.string().max(4096).refine(s => !/[\u0000-\u001f\u007f]/.test(s), "control characters are unsupported");
export const DiagnosticCheckerSchema = z.object({
  parser: z.enum(["tsc", "ruff-json", "go-vet"]),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,12}$/)).min(1).max(16),
  executable: literal.refine(s => s.length > 0),
  args: z.array(literal).max(32),
  timeoutMs: z.number().int().min(250).max(30_000).default(10_000),
  maxOutputBytes: z.number().int().min(4096).max(262_144).default(65_536),
}).strict().refine(c => Buffer.byteLength(JSON.stringify([c.executable, ...c.args])) <= 16_384, "argv exceeds 16 KiB");
export const DiagnosticsConfigSchema = z.array(DiagnosticCheckerSchema).max(8).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const entry of entries) for (const extension of entry.extensions) {
    if (seen.has(extension)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate diagnostic extension ${extension}` });
    seen.add(extension);
  }
});
export type DiagnosticChecker = z.infer<typeof DiagnosticCheckerSchema>;
export type DiagnosticsConfig = z.input<typeof DiagnosticsConfigSchema>;
export const DiagnosticsSchema = z.object({
  path: z.string().max(4096), contentHash: z.string().max(64),
  status: z.enum(["reported", "unavailable", "incomplete", "changed"]),
  reason: z.string().max(256),
  checkerCallId: z.string().max(128).optional(),
  exitCode: z.number().int().nullable(),
  otherFileCount: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  entries: z.array(z.object({ line: z.number().int().positive(), column: z.number().int().positive().optional(),
    code: z.string().max(64).optional(), message: z.string().max(1024) }).strict()).max(100),
}).strict();
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;
export const InternalToolSchema = z.object({ kind: z.enum(["diagnostics", "attachment"]), parentToolUseId: z.string() }).strict();
