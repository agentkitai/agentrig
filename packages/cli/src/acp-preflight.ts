import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

export const AcpSessionParams = z.object({ sessionId: z.string().max(128) }).strict();
export const AcpEventsParams = AcpSessionParams.extend({ enabled: z.boolean() });
export const AcpMemoryParams = AcpSessionParams.extend({ query: z.string().max(4096).default("") });
const extensions = new Map<string, z.ZodTypeAny>([["_agentrig/state", AcpSessionParams], ["_agentrig/events", AcpEventsParams],
  ["_agentrig/supervisor", AcpSessionParams], ["_agentrig/memory", AcpMemoryParams]]);
const methods = new Map([["initialize", "InitializeRequest"], ["session/new", "NewSessionRequest"],
  ["session/prompt", "PromptRequest"], ["session/cancel", "CancelNotification"]]);
let validator: Ajv2020 | undefined;
function official(name: string, value: unknown): boolean {
  if (validator === undefined) {
    const schema = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/sdk/schema/schema.json"), "utf8"));
    validator = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
    validator.addSchema(schema, "acp");
  }
  return validator.getSchema(`acp#/$defs/${name}`)!(value) === true;
}

/** Additional preflight, not replacement dispatch. The SDK still validates the request.
 * Invalid payloads never reach its potentially reflective generated error formatter. */
export function acpPreflight(method: string, params: unknown): boolean {
  const pending: Array<[unknown, number]> = [[params, 0]]; let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (++nodes > 8192 || depth > 32) return false;
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
  }
  const extension = extensions.get(method);
  if (extension !== undefined) return extension.safeParse(params).success;
  const name = methods.get(method);
  return name !== undefined && official(name, params);
}

export function acpResult<T>(value: T): T {
  // Leaves room for JSON-RPC envelope and bounded original request id.
  if (Buffer.byteLength(JSON.stringify(value)) > 130_000) throw new Error("ACP result exceeds response capacity");
  return value;
}
