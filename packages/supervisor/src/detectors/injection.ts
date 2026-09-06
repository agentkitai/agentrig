import type { ContentBlock } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import { signal } from "../types.js";

/** Bounded syntax heuristic over known external ancestry, not an authorization mechanism. */
export function injectionDetector(): Detector {
  return {
    id: "injection",
    observe(event) {
      const messages = event.type === "message.append" ? [event.message]
        : event.type === "context.compact" ? event.messages ?? [] : [];
      let chars = 16_384;
      let blocks = 4096;
      const scan = (values: readonly ContentBlock[], inherited = false, depth = 0): boolean => {
        if (depth > 32) return false;
        for (const block of values) {
          if (--blocks < 0 || chars <= 0) return false;
          const external = inherited || block.trust === "external";
          const text = block.type === "text" ? block.text
            : block.type === "tool_result" && typeof block.content === "string" ? block.content : "";
          if (external) {
            const bounded = text.slice(0, chars); chars -= bounded.length;
            if (/ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|\b(?:tool_use|function_call)\b|<\/?(?:system|developer|tool_call)>|\b(?:curl|wget)\b.{0,200}\|\s*(?:ba)?sh\b/i.test(bounded)) return true;
          }
          if (block.type === "tool_result" && Array.isArray(block.content) && scan(block.content, external, depth + 1)) return true;
        }
        return false;
      };
      for (const message of messages) {
        if (scan(message.content)) return signal("injection", 0.7,
          [`instruction-shaped external content in ${event.type} #${event.seq}; heuristic, not proof of intent`], [event.seq, event.seq]);
        if (blocks <= 0 || chars <= 0) break;
      }
      return null;
    },
  };
}
