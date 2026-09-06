import { randomUUID } from "node:crypto";
import type { EventPayload } from "./events.js";
import type { AnyTool, ToolContext, ToolResult } from "./tool.js";
import { QUESTION_TIMEOUT_MS, QuestionSchema, QuestionReplySchema, questionAnswer, type Question, type QuestionHandler } from "./questions.js";

const factories = new WeakMap<AnyTool, AnyTool["execute"]>();
const bindings = new WeakMap<ToolContext, (question: Question) => Promise<ToolResult>>();
const sources = new WeakMap<ToolResult, "user" | "external">();
export interface QuestionState { failed?: string }
export function isQuestionTool(tool: AnyTool): boolean { return factories.get(tool) === tool.execute; }
export function questionResultTrust(result: ToolResult): "user" | "external" | undefined { return sources.get(result); }

/** Only the actual builtin object and original implementation receive this runtime seam. */
export function bindQuestion(tool: AnyTool, ctx: ToolContext, toolUseId: string, state: QuestionState,
  emit: (payload: EventPayload) => Promise<unknown>, handler?: QuestionHandler): void {
  if (!isQuestionTool(tool)) return;
  bindings.set(ctx, async question => {
    const request = { ...question, id: randomUUID(), sessionId: ctx.sessionId, toolUseId };
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, QUESTION_TIMEOUT_MS);
    timer.unref?.();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("question cancelled"));
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    void cancelled.catch(() => {}); // Covers an append failure before the answer race is installed.
    let outcome: "answered" | "unavailable" | "timeout" | "cancelled" = "unavailable";
    try {
      await emit({ type: "question.asked", id: request.id, toolUseId, question });
      const reply = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return handler?.(request, controller.signal) ?? null;
      }), cancelled]);
      controller.signal.throwIfAborted();
      if (reply === null) throw new Error("answer unavailable");
      const parsed = QuestionReplySchema.parse(reply);
      const answer = questionAnswer(question, parsed.answer);
      outcome = "answered";
      await emit({ type: "question.answered", id: request.id, toolUseId, outcome, reply: parsed });
      const result: ToolResult = { output: { answer, source: parsed.source }, display: `Clarification (${parsed.source}; not permission approval): ${answer}` };
      sources.set(result, parsed.source === "human" ? "user" : "external");
      return result;
    } catch {
      outcome = ctx.signal.aborted ? "cancelled" : timedOut ? "timeout" : "unavailable";
      await emit({ type: "question.answered", id: request.id, toolUseId, outcome });
      if (!ctx.signal.aborted) state.failed = `Required question ${outcome}; no answer supplied. Configure an answer policy or use an interactive question client.`;
      return { output: { outcome }, display: state.failed ?? "Question cancelled", isError: true };
    } finally {
      clearTimeout(timer); controller.abort();
      controller.signal.removeEventListener("abort", cancel);
      ctx.signal.removeEventListener("abort", abort);
    }
  });
}

export function askUserTool(): AnyTool {
  const tool: AnyTool = {
    name: "ask_user", description: "Ask one required clarification: a prompt, 2–4 distinct options, with free text always allowed. Answers are not permission approvals. A missing required answer ends this run.",
    inputSchema: QuestionSchema, permission: "read", effects: "read-only", sandbox: "compatible",
    // This interaction reads no filesystem paths. Explicit read/tool denies still win.
    paths: () => [],
    resultSource: "external",
    execute: async (input: Question, ctx) => {
      const ask = bindings.get(ctx);
      if (ask === undefined) throw new Error("ask_user requires the core question runtime");
      return ask(QuestionSchema.parse(input));
    },
  };
  factories.set(tool, tool.execute);
  return tool;
}
