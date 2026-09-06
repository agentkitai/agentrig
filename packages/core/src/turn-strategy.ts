import type { ContentBlock } from "./messages.js";
import { parallelRuntime } from "./parallel-runtime.js";

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

/** Opt-in bounded scheduling. Unknown effects are ordered exclusive barriers, never name heuristics. */
export function parallel(options: { maxConcurrency?: number } = {}): TurnStrategy {
  const limit = options.maxConcurrency ?? 4;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("maxConcurrency must be an integer from 1 to 16");
  return Object.freeze({ execute(calls: readonly TurnToolCall[], context: TurnStrategyContext) {
    const runtime = parallelRuntime(context);
    // A custom wrapper without the internal runtime bridge cannot safely infer tool hazards.
    return runtime === undefined ? sequential.execute(calls, context) : runtime(calls, limit);
  } });
}
