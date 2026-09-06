import type { ContentBlock } from "./messages.js";

export interface TurnToolCall { id: string; name: string; input: unknown }
export interface TurnStrategyContext {
  readonly signal: AbortSignal;
  /** The existing validated/authorized tool pipeline, not direct tool-body access. */
  runTool(call: TurnToolCall): Promise<ContentBlock>;
}
export interface TurnStrategyResult {
  results: ContentBlock[];
  /** Stop the turn without appending this batch's results to the conversation. */
  interrupted: boolean;
}
/** Trusted host SDK injection. No model/config loading; implementations must join dispatched work. */
export interface TurnStrategy {
  execute(calls: readonly TurnToolCall[], context: TurnStrategyContext): Promise<TurnStrategyResult>;
}

/** Existing ordering, including the historical before-next-call cancellation boundary. */
export const sequential: TurnStrategy = Object.freeze({
  async execute(calls: readonly TurnToolCall[], context: TurnStrategyContext): Promise<TurnStrategyResult> {
    const results: ContentBlock[] = [];
    for (const call of calls) {
      if (context.signal.aborted) return { results: [], interrupted: true };
      results.push(await context.runTool(call));
    }
    // An abort during the last call historically still appends its result batch.
    return { results, interrupted: false };
  },
});
