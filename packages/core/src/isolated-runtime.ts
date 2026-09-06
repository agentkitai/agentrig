import type { AnyTool, ToolContext } from "./tool.js";

// Object identity, never a model field/tool name. Not exported from the SDK entrypoint.
const tools = new WeakSet<AnyTool>();
const contexts = new WeakMap<ToolContext, { ready(): void; excludes: string[] }>();
export function markIsolatedTool(tool: AnyTool): AnyTool { tools.add(tool); return tool; }
export function isIsolatedTool(tool: AnyTool): boolean { return tools.has(tool); }
export function bindIsolatedContext(ctx: ToolContext, ready: () => void, excludes: string[]): void {
  contexts.set(ctx, { ready, excludes });
}
export function isolatedContext(ctx: ToolContext) { return contexts.get(ctx); }
