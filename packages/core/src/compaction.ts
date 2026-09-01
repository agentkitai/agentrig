import type { ContentBlock, Message } from "./messages.js";
import type { ModelProvider } from "./provider.js";

export interface CompactionStrategy {
  shouldCompact(usage: { tokens: number; window: number }): boolean;
  /** `signal` is the session's abort signal — a strategy must stop summarizing when it fires. */
  compact(messages: Message[], provider: ModelProvider, signal?: AbortSignal): Promise<Message[]>;
}

export interface SummarizeOptions {
  /** Compact once the last response's context passes this fraction of the window (default 0.7). */
  thresholdFraction?: number;
  /** Messages kept verbatim at the tail (default 8); the boundary is widened so no tool_result is orphaned. */
  keepLastMessages?: number;
  /** max_tokens for the summarization call (default 1024). */
  maxSummaryTokens?: number;
}

export const COMPACTION_SUMMARY_PREFIX = "[context compacted: summary of ";

/** Compaction owns this synthetic message, so consumers need not guess from the user role alone. */
export function isCompactionSummary(block: ContentBlock): boolean {
  return block.type === "text" && block.text.startsWith(COMPACTION_SUMMARY_PREFIX);
}

const SUMMARY_SYSTEM =
  "You compress agent conversation history. Summarize the transcript into a dense brief a coding agent " +
  "can resume from: the goal, what has been tried, what worked and failed (with error messages), current " +
  "state of files touched, and what remains. Keep concrete identifiers (paths, commands, names) verbatim. " +
  "Reply with the summary only.";

function blockToTranscript(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "tool_use":
      return `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 400)}]`;
    case "tool_result": {
      const text = typeof b.content === "string" ? b.content : b.content.map(blockToTranscript).join("\n");
      return `[tool_result${b.isError ? " ERROR" : ""}] ${text.slice(0, 1000)}`;
    }
    case "image":
      return "[image]";
  }
}

function toTranscript(messages: Message[]): string {
  return messages.map((m) => `${m.role}:\n${m.content.map(blockToTranscript).join("\n")}`).join("\n\n");
}

/**
 * v1 strategy from PLAN §2.8: summarize older turns past 70% of the window, keep the tail
 * verbatim. The first message (the task) always survives; the cut is widened backwards so a
 * kept tool_result never loses its assistant tool_use.
 */
export function summarizeOlderTurns(opts: SummarizeOptions = {}): CompactionStrategy {
  const threshold = opts.thresholdFraction ?? 0.7;
  const keep = opts.keepLastMessages ?? 8;
  const maxSummaryTokens = opts.maxSummaryTokens ?? 1024;

  return {
    shouldCompact: ({ tokens, window }) => tokens > threshold * window,

    async compact(messages, provider, signal) {
      let cut = messages.length - keep;
      // never orphan a tool_result: pull the boundary back until the kept tail doesn't
      // start with results whose tool_use would be summarized away
      while (cut > 1 && messages[cut]!.role === "user" && messages[cut]!.content.some((b) => b.type === "tool_result")) {
        cut -= 1;
      }
      if (cut <= 1) return messages;

      const older = messages.slice(1, cut);
      let summary = "";
      for await (const ev of provider.stream(
        {
          system: SUMMARY_SYSTEM,
          messages: [{ role: "user", content: [{ type: "text", text: toTranscript(older) }] }],
          tools: [],
          maxTokens: maxSummaryTokens,
        },
        signal ?? new AbortController().signal,
      )) {
        if (ev.type === "text_delta") summary += ev.text;
      }
      // an empty summary (refusal, degenerate stream) must not replace real history with nothing
      if (summary.trim() === "") return messages;

      return [
        messages[0]!,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${COMPACTION_SUMMARY_PREFIX}${older.length} earlier messages]\n${summary.trim()}`,
            },
          ],
        },
        ...messages.slice(cut),
      ];
    },
  };
}
