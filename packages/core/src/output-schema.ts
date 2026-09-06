import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";

export type OutputMode = "prompted" | "native";
export type OutputCategory = "valid" | "json" | "schema" | "bound" | "tool" | "stop";
export interface OutputContract {
  readonly schema: boolean | Record<string, unknown>;
  readonly digest: string;
  readonly mode: OutputMode;
  validate(text: string): OutputCategory;
}
const contracts = new WeakSet<OutputContract>();
export function assertOutputContract(value: OutputContract): void {
  if (!contracts.has(value)) throw new Error("Output contract must be compiled by createOutputContract");
}
export const OUTPUT_LIMITS = { schemaBytes: 32_768, schemaDepth: 12, schemaNodes: 512, textBytes: 65_536, textDepth: 32 } as const;

/** Bounded JSON parser with duplicate-key refusal; no reviver can recover overwritten keys. */
export function parseOutputJson(text: string, bytes: number, maxDepth: number, maxNodes = 16_384): unknown {
  if (Buffer.byteLength(text) > bytes) throw new Error("bound");
  let at = 0, nodes = 0;
  const ws = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === "\\") at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new Error("json");
  };
  const value = (depth: number): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error("bound");
    ws(); const ch = text[at];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      at++; ws(); const object = ch === "{", end = object ? "}" : "]";
      const result: Record<string, unknown> = Object.create(null), list: unknown[] = [], keys = new Set<string>();
      if (text[at] === end) { at++; return object ? result : list; }
      while (at < text.length) {
        ws(); let key = "";
        if (object) {
          if (text[at] !== '"') throw new Error("json");
          key = string(); if (keys.has(key)) throw new Error("json"); keys.add(key);
          ws(); if (text[at++] !== ":") throw new Error("json");
        }
        const item = value(depth + 1); if (object) result[key] = item; else list.push(item);
        ws(); const next = text[at++];
        if (next === end) return object ? result : list;
        if (next !== ",") throw new Error("json");
      }
      throw new Error("json");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0];
    if (token === undefined) throw new Error("json"); at += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error("json");
    return parsed;
  };
  const result = value(0); ws(); if (at !== text.length) throw new Error("json"); return result;
}

const keywords = new Set(["$schema", "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]);
const nativeKeywords = new Set(["$schema", "type", "properties", "required", "additionalProperties", "items", "enum"]);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function checkSchema(node: unknown, mode: OutputMode, root = true): asserts node is boolean | Record<string, unknown> {
  if (typeof node === "boolean") { if (mode === "native") throw new Error("native schema unsupported"); return; }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("schema");
  const schema = node as Record<string, unknown>;
  if (Object.keys(schema).some(key => !(mode === "native" ? nativeKeywords : keywords).has(key))) throw new Error("unsupported schema keyword");
  if (schema.$schema !== undefined && (!root || schema.$schema !== "https://json-schema.org/draft/2020-12/schema")) throw new Error("schema dialect");
  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!list.every(type => typeof type === "string" && types.has(type)) ||
      list.length > 2 || list.length === 0 || new Set(list).size !== list.length || list.length === 2 && !list.includes("null")) throw new Error("schema type");
  }
  if (mode === "native" && (schema.type === undefined || root && schema.type !== "object")) throw new Error("native object root required");
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new Error("schema properties");
    for (const child of Object.values(schema.properties)) checkSchema(child, mode, false);
  }
  if (schema.items !== undefined) checkSchema(schema.items, mode, false);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") checkSchema(schema.additionalProperties, mode, false);
  const object = schema.type === "object" || Array.isArray(schema.type) && schema.type.includes("object");
  const array = schema.type === "array" || Array.isArray(schema.type) && schema.type.includes("array");
  if (mode === "native" && array && schema.items === undefined) throw new Error("native array requires items");
  if (mode === "native" && object) {
    const keys = Object.keys((schema.properties ?? {}) as object);
    if (schema.additionalProperties !== false || !Array.isArray(schema.required) || schema.required.length !== keys.length || keys.some(key => !(schema.required as unknown[]).includes(key))) throw new Error("native object must require exactly its properties");
  }
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
}
/** Strict documented subset, compiled once. Native is operator opt-in, not server attestation. */
export function createOutputContract(input: unknown, mode: OutputMode = "prompted"): OutputContract {
  if (mode !== "prompted" && mode !== "native") throw new Error("output mode must be prompted or native");
  let schema: unknown;
  try {
    schema = parseOutputJson(JSON.stringify(input), OUTPUT_LIMITS.schemaBytes, OUTPUT_LIMITS.schemaDepth, OUTPUT_LIMITS.schemaNodes);
    checkSchema(schema, mode);
    const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    const validate = ajv.compile(schema);
    const encoded = JSON.stringify(schema); freeze(schema);
    const contract: OutputContract = Object.freeze({ schema, mode, digest: createHash("sha256").update(encoded).digest("hex"),
      validate(text: string): OutputCategory {
        try { return validate(parseOutputJson(text, OUTPUT_LIMITS.textBytes, OUTPUT_LIMITS.textDepth)) ? "valid" : "schema"; }
        catch (error) { return error instanceof Error && error.message === "bound" ? "bound" : "json"; }
      } });
    contracts.add(contract); return contract;
  } catch { throw new Error("Output schema refused: require the documented bounded strict JSON-Schema subset and native-compatible shape when selected"); }
}
