import { z } from "zod";
import type { EventOf } from "../events.js";
import type { SessionStore } from "../session-store.js";
import type { Tool, ToolResult } from "../tool.js";
import { DISPLAY_CAP, splitsSurrogatePair } from "./shared.js";

export const READ_OUTPUT_TOOL = "read_output";

const OUTPUT_MARKER = /\n… \[output artifact; cursor (\d+) of (\d+) UTF-16 code units; read next with (read_output \{"seq":\d+,"from":\d+,"to":\d+\})\]$/;

export function outputArtifactMarker(seq: number, from: number, to: number, total: number): string {
  return `\n… [output artifact; cursor ${from} of ${total} UTF-16 code units; read next with ` +
    `${READ_OUTPUT_TOOL} {"seq":${seq},"from":${from},"to":${to}}]`;
}

export function outputHandleFromDisplay(display: string): string | undefined {
  return OUTPUT_MARKER.exec(display)?.[3];
}

const ReadOutputInput = z.object({
  seq: z.number().int().nonnegative().describe("Sequence number from an overflow handle"),
  from: z.number().int().nonnegative().describe("Zero-based UTF-16 code-unit offset to start at (inclusive)"),
  to: z.number().int().positive().describe("Zero-based UTF-16 code-unit offset to stop at (exclusive)"),
}).superRefine((input, ctx) => {
  if (input.to <= input.from) {
    ctx.addIssue({ code: "custom", message: "to must be greater than from" });
  } else if (input.to - input.from > DISPLAY_CAP) {
    ctx.addIssue({
      code: "custom",
      message: `range may contain at most ${DISPLAY_CAP} UTF-16 code units; reduce to - from`,
    });
  }
});
type ReadOutputInput = z.infer<typeof ReadOutputInput>;

/**
 * Read a bounded range from an oversized tool result in this session's append-only event log.
 * The session id comes from ToolContext rather than model input, so a handle cannot cross sessions.
 */
export function readOutputTool(store: SessionStore): Tool<ReadOutputInput, string> {
  return {
    name: READ_OUTPUT_TOOL,
    description:
      "Read a UTF-16 code-unit range from a truncated tool result's complete immutable-log output. " +
      "Use the {seq, from, to} handle shown in that result; from is inclusive, to is exclusive, " +
      `and one read may contain at most ${DISPLAY_CAP} code units. ` +
      "This reads only output from an already-authorized tool call in the current session, so no extra permission is required.",
    inputSchema: ReadOutputInput,
    permission: "read",
    async execute(input, ctx): Promise<ToolResult<string>> {
      let event: EventOf<"tool.result"> | undefined;
      let sealed = false;
      for await (const candidate of store.read(ctx.sessionId)) {
        if (ctx.signal.aborted) return { output: "", display: "read_output aborted", isError: true };
        if (candidate.seq === input.seq && candidate.type === "tool.result") event = candidate;
        if (
          event !== undefined && candidate.type === "tool.result.patched" &&
          candidate.id === event.id && candidate.by === "post_tool" && candidate.mode !== "inject"
        ) sealed = true;
      }
      if (event?.truncated !== true || event.output === undefined) {
        const display = `seq ${input.seq} is not an output artifact; use the seq from a truncated tool result's read_output handle`;
        return { output: "", display, isError: true };
      }
      if (sealed) {
        return {
          output: "",
          display: `post_tool hook sealed this artifact; use the patched tool result instead of read_output seq ${input.seq}`,
          isError: true,
        };
      }
      if (input.from >= event.output.length) {
        const display =
          `from ${input.from} is outside output seq ${input.seq} (${event.output.length} UTF-16 code units); ` +
          `choose from between 0 and ${Math.max(0, event.output.length - 1)}`;
        return { output: "", display, isError: true };
      }
      if (input.to > event.output.length) {
        const display =
          `to ${input.to} exceeds output seq ${input.seq} (${event.output.length} UTF-16 code units); ` +
          `set to at most ${event.output.length}`;
        return { output: "", display, isError: true };
      }
      if (splitsSurrogatePair(event.output, input.from)) {
        return {
          output: "",
          display: `from ${input.from} splits a surrogate pair in output seq ${input.seq}; set \`from\` to ${input.from - 1}`,
          isError: true,
        };
      }
      if (splitsSurrogatePair(event.output, input.to)) {
        return {
          output: "",
          display: `to ${input.to} splits a surrogate pair in output seq ${input.seq}; set \`to\` to ${input.to - 1}`,
          isError: true,
        };
      }
      const output = event.output.slice(input.from, input.to);
      return { output, display: output };
    },
  };
}
