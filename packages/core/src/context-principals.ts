import { randomUUID } from "node:crypto";
import type { Hook } from "./hooks.js";
import type { ContentBlock, InstructionContext, Message } from "./messages.js";

export const PLATFORM_CONTEXT: InstructionContext = Object.freeze({ principal: "platform", authority: "instruction" });
export const ADVISORY_CONTEXT: InstructionContext = Object.freeze({ principal: "platform", authority: "advisory" });
export const USER_CONTEXT: InstructionContext = Object.freeze({ principal: "user", authority: "instruction" });

export type DelegationChange = { principal: string; action: "delegated" | "revoked"; delegation: string };

/** A bounded instruction-source seam, deliberately unrelated to tool permission grants. */
export function contextPrincipals(hooks: readonly Hook[]) {
  const registered = new Map<Hook, string>();
  const named = new Map<string, Hook[]>();
  for (const hook of hooks) {
    if (hook.id !== undefined) named.set(hook.id, [...(named.get(hook.id) ?? []), hook]);
  }
  hooks.forEach((hook, index) => {
    const unique = hook.id !== undefined && hook.id.length > 0 && hook.id.length <= 128 && named.get(hook.id)?.length === 1;
    registered.set(hook, unique ? `hook:${hook.id}` : `hook:anonymous:${index}`);
  });
  // Reserve anonymous identity strings: an explicit display id cannot alias that namespace.
  for (const [hook, principal] of registered) {
    if (hook.id?.startsWith("anonymous:")) registered.set(hook, `hook:anonymous:${hooks.indexOf(hook)}`);
  }
  const live = new Map<string, string>();
  const changes: DelegationChange[] = [];
  let count = 0;
  let closed = false;
  const effective = (context: InstructionContext): InstructionContext => {
    if (context.principal.startsWith("hook:") && (context.delegation === undefined || live.get(context.principal) !== context.delegation)) {
      return { principal: context.principal, authority: "advisory" };
    }
    return { ...context };
  };
  return {
    hook(hook: Hook): InstructionContext {
      const principal = registered.get(hook) ?? "hook:anonymous:unregistered";
      const delegation = live.get(principal);
      return delegation === undefined ? { principal, authority: "advisory" } : { principal, authority: "instruction", delegation };
    },
    set(id: string, enabled: boolean): boolean {
      const targets = named.get(id);
      if (closed || typeof id !== "string" || typeof enabled !== "boolean" || id.length === 0 || id.length > 128 || id.startsWith("anonymous:") || targets?.length !== 1) return false;
      const principal = registered.get(targets[0]!)!;
      if (enabled === live.has(principal)) return true;
      // At most 128 grants and their matching revocations: exhaustion must never block revoke.
      if (enabled && count >= 128) return false;
      const delegation = enabled ? randomUUID() : live.get(principal)!;
      if (enabled) live.set(principal, delegation); else live.delete(principal);
      changes.push({ principal, action: enabled ? "delegated" : "revoked", delegation });
      if (enabled) count += 1;
      return true;
    },
    drain(): DelegationChange[] { return changes.splice(0); },
    effective,
    messages(messages: Message[]): Message[] {
      const block = (value: ContentBlock): ContentBlock => ({ ...value,
        ...(value.context === undefined ? {} : { context: effective(value.context) }),
        ...(value.type === "tool_result" && Array.isArray(value.content) ? { content: value.content.map(block) } : {}),
      });
      return messages.map(message => ({ ...message, content: message.content.map(block) }));
    },
    close() { closed = true; live.clear(); },
  };
}

/** Mixed hook contributions are platform-assembled advisory content, not a borrowed identity. */
export function combinedContext(contexts: readonly InstructionContext[]): InstructionContext {
  const first = contexts[0];
  return first !== undefined && contexts.every(context => context.principal === first.principal &&
    context.authority === first.authority && context.delegation === first.delegation) ? { ...first } : { ...ADVISORY_CONTEXT };
}
