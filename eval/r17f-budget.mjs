// R17f-only observable scheduling, composed over the existing shared usage ledger.
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EvaluationBudget } from '../packages/cli/dist/evaluation-budget.js';

export class R17fBudget extends EvaluationBudget {
  reserved = 0;
  stopped = null;
  writes = Promise.resolve();

  constructor(tokens, minutes, output) {
    super(tokens, minutes);
    this.output = output;
    // Original E3's conservative unknown-call reserve, capped at 10% for smaller
    // explicit budgets. Headroom is scheduling only, never reported consumption.
    this.headroom = Math.min(1_178_000, Math.ceil(tokens / 10));
  }

  guard() {
    super.guard();
    if (this.stopped !== null) throw new Error(this.stopped);
  }

  record(event) {
    const next = this.writes.then(() => appendFile(join(this.output, 'progress.jsonl'),
      `${JSON.stringify({ at: Date.now(), ...event })}\n`));
    // The caller sees the failure and scheduling stays stopped, but joining the
    // journal must not prevent best-effort results/calls publication in finally.
    this.writes = next.catch(() => {
      this.stopped ??= 'evaluation stopped: progress journal write failed';
    });
    return next;
  }

  provider(provider, role) {
    const ledger = this, metered = super.provider(provider, role);
    return { id: metered.id, model: metered.model, capabilities: metered.capabilities,
      async *stream(request, signal) {
        ledger.guard();
        if (ledger.tokens + ledger.reserved + ledger.headroom > ledger.maxTokens) {
          ledger.stopped = 'evaluation stopped: insufficient conservative token headroom';
          await ledger.record({ phase: 'admission-refused', role, tokens: ledger.tokens,
            reserved: ledger.reserved, headroom: ledger.headroom });
          throw new Error(ledger.stopped);
        }
        ledger.reserved += ledger.headroom;
        const id = randomUUID();
        let offset;
        try {
          await ledger.record({ phase: 'call-start', id, role, tokens: ledger.tokens });
          // No await between capturing the offset and entering the metered stream:
          // its first step appends this call before yielding to another provider.
          offset = ledger.calls.length;
          yield* metered.stream(request, signal);
        } finally {
          ledger.reserved -= ledger.headroom;
          await ledger.record({ phase: 'call-settled', id, role,
            call: offset === undefined ? null : ledger.calls[offset] ?? null,
            tokens: ledger.tokens, unknownCalls: ledger.unknownCalls });
        }
      } };
  }
}
