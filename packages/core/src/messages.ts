import { z } from "zod";
import { DiagnosticsSchema, type Diagnostics } from "./diagnostics-types.js";

/** Trusted transports may attach data, never extra user instructions or grants. */
export const AdvisoryPromptContextSchema = z.array(z.string().max(32_768)).max(32)
  .refine(values => values.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <= 262_144,
    "advisory prompt context exceeds 256 KiB");
export function advisoryPromptBlocks(values: readonly string[]): ContentBlock[] {
  return values.map(text => ({ type: "text", text, trust: "external",
    context: { principal: "platform", authority: "advisory" } }));
}

/** Unified message schema. Providers map to/from this; core never sees a vendor payload. */

/** Host-supplied provenance metadata, not an authorization grant or proof of authority. */
export const ContentTrustSchema = z.enum(["user", "project", "external", "tool-output", "generated"]);
export type ContentTrust = z.infer<typeof ContentTrustSchema>;

export const ContextPrincipalSchema = z.union([
  z.enum(["user", "supervisor", "platform"]), z.string().max(256).regex(/^hook:.+/),
]);
export const InstructionContextSchema = z.object({
  principal: ContextPrincipalSchema,
  authority: z.enum(["instruction", "advisory"]),
  /** An audit receipt, not authority without the current run's live delegation. */
  delegation: z.string().max(64).optional(),
});
export type InstructionContext = z.infer<typeof InstructionContextSchema>;

export type ContentBlock = { trust?: ContentTrust; context?: InstructionContext } & (
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean; diagnostics?: Diagnostics }
  | { type: "image"; mediaType: string; data: string });

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// zod mirrors of the types above, for anything that crosses a file boundary (session snapshots).
// The cast bridges zod's inference quirk on z.unknown() keys; the runtime validation is exact.
export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(
  () =>
    z.union([
      z.object({ type: z.literal("text"), text: z.string(), trust: ContentTrustSchema.optional(), context: InstructionContextSchema.optional() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown(), trust: ContentTrustSchema.optional(), context: InstructionContextSchema.optional() }),
      z.object({
        type: z.literal("tool_result"),
        toolUseId: z.string(),
        content: z.union([z.string(), z.array(ContentBlockSchema)]),
        isError: z.boolean().optional(),
        diagnostics: DiagnosticsSchema.optional(),
        trust: ContentTrustSchema.optional(),
        context: InstructionContextSchema.optional(),
      }),
      z.object({ type: z.literal("image"), mediaType: z.string(), data: z.string(), trust: ContentTrustSchema.optional(), context: InstructionContextSchema.optional() }),
    ]) as z.ZodType<ContentBlock>,
);

export const MessageSchema: z.ZodType<Message> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentBlockSchema),
});
