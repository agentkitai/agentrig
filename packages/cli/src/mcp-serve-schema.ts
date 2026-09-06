import { z } from "zod/v4";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
export const RunTaskInput = z.strictObject({ task: z.string().min(1).max(65_536),
  maxTurns: z.number().int().min(1).max(20).optional(), maxTokens: z.number().int().min(1).max(8192).optional() });
export type RunTaskInput = z.infer<typeof RunTaskInput>;
export const MCP_TOOL_INPUTS = Object.freeze({
  run_task: RunTaskInput,
  list_sessions: z.strictObject({ limit: z.number().int().min(1).max(100).default(20) }),
  read_session: z.strictObject({ id: z.string().min(1).max(128) }),
  memory_search: z.strictObject({ query: z.string().max(4096) }),
});
// Existing pinned Zod has validation but predates Standard JSON Schema.
// Adapt the same public converter, rather than duplicating tool schemas.
export function standard<T extends z.ZodType>(schema: T): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  return { "~standard": { ...schema["~standard"], jsonSchema: {
    input: () => z.toJSONSchema(schema, { io: "input" }),
    output: () => z.toJSONSchema(schema, { io: "output" }),
  } } };
}
