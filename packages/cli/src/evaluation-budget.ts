import { randomUUID } from "node:crypto";
import { usageTokens, usageUsd, type ModelProvider, type Usage, type Pricing } from "@agentkitai/agentrig-core";

export interface EvaluationCall {
  id: string; role: "main" | "supervisor"; startedAt: number; endedAt?: number;
  usage: Usage | null; complete: boolean; retried: boolean;
}

/** Shared scheduling/accounting gate, not a guarantee about remote billing or in-flight tokens. */
export class EvaluationBudget {
  readonly startedAt = Date.now();
  readonly calls: EvaluationCall[] = [];
  readonly controller = new AbortController();
  tokens = 0;
  unknownCalls = 0;
  reportedUsd = 0;
  private timer: ReturnType<typeof setTimeout>;
  private parent: AbortSignal | undefined;
  private readonly onAbort = () => this.controller.abort();

  constructor(readonly maxTokens: number, readonly maxMinutes: number, signal?: AbortSignal,
    readonly priced?: { maxUsd?: number; pricing: Pricing }) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 100_000_000
      || !Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 24 * 60)
      throw new Error("explicit batch limits must be finite: 1–100000000 tokens, at most 1440 minutes");
    this.parent = signal;
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.controller.abort();
    this.timer = setTimeout(() => this.controller.abort(), maxMinutes * 60_000);
    this.timer.unref();
  }

  guard(): void {
    if (this.controller.signal.aborted) throw new Error("evaluation cancelled or batch deadline reached");
    if (this.unknownCalls) throw new Error("evaluation stopped: provider usage is incomplete");
    if (this.tokens >= this.maxTokens) throw new Error("evaluation reported-token scheduling limit reached");
    if (this.priced?.maxUsd !== undefined && this.reportedUsd >= this.priced.maxUsd)
      throw new Error("evaluation priced-usage scheduling limit reached");
  }

  close(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
  }

  provider(provider: ModelProvider, role: EvaluationCall["role"]): ModelProvider {
    const budget = this;
    return {
      id: provider.id, model: provider.model, capabilities: provider.capabilities,
      async *stream(request, signal) {
        budget.guard();
        const call: EvaluationCall = {
          id: randomUUID(), role, startedAt: Date.now(), usage: null, complete: false, retried: false,
        };
        budget.calls.push(call);
        let stopped = false, failed = false;
        try {
          for await (const event of provider.stream(request, AbortSignal.any([signal, budget.controller.signal]))) {
            if (event.type === "retry") call.retried = true;
            if (event.type === "usage") call.usage = event.reported === false ? null : event.usage;
            if (event.type === "stop") { stopped = true; failed ||= event.reason === "error"; }
            yield event;
          }
        } catch (error) { failed = true; throw error; }
        finally {
          call.endedAt = Date.now();
          call.complete = stopped && !failed && !call.retried && call.usage !== null;
          if (call.usage !== null) budget.tokens += usageTokens(call.usage);
          if (call.usage !== null && budget.priced !== undefined)
            budget.reportedUsd += usageUsd(call.usage, budget.priced.pricing,
              provider.capabilities.cacheReadDiscount, provider.capabilities.cacheWriteMultiplier);
          if (!Number.isSafeInteger(budget.tokens)) {
            call.complete = false;
            budget.controller.abort();
          }
          if (!call.complete) budget.unknownCalls += 1;
        }
      },
    };
  }
}
