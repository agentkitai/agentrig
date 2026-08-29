import { z } from "zod";

/** Unified message schema. Providers map to/from this; core never sees a vendor payload. */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { type: "image"; mediaType: string; data: string };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// zod mirrors of the types above, for anything that crosses a file boundary (session snapshots).
// The cast bridges zod's inference quirk on z.unknown() keys; the runtime validation is exact.
export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(
  () =>
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({
        type: z.literal("tool_result"),
        toolUseId: z.string(),
        content: z.union([z.string(), z.array(ContentBlockSchema)]),
        isError: z.boolean().optional(),
      }),
      z.object({ type: z.literal("image"), mediaType: z.string(), data: z.string() }),
    ]) as z.ZodType<ContentBlock>,
);

export const MessageSchema: z.ZodType<Message> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentBlockSchema),
});
