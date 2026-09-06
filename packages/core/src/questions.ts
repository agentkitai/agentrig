import { z } from "zod";

export const QUESTION_TIMEOUT_MS = 120_000;
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "must not be blank");
export const QuestionSchema = z.object({
  prompt: text(2048), options: z.array(text(256)).min(2).max(4)
    .refine(values => new Set(values).size === values.length, "options must be distinct"),
}).strict();
export type Question = z.infer<typeof QuestionSchema>;
export const QuestionChoiceSchema = z.union([
  z.object({ option: z.number().int().min(0).max(3) }).strict(),
  z.object({ text: text(4096) }).strict(),
]);
export type QuestionChoice = z.infer<typeof QuestionChoiceSchema>;
export const QuestionReplySchema = z.object({
  source: z.enum(["human", "first-option", "file", "supervisor"]), answer: QuestionChoiceSchema,
}).strict();
export type QuestionReply = z.infer<typeof QuestionReplySchema>;
export interface QuestionRequest extends Question { id: string; sessionId: string; toolUseId: string }
/** Explicit trusted-host answering policy. Null means the required answer is unavailable. */
export type QuestionHandler = (request: QuestionRequest, signal: AbortSignal) => Promise<QuestionReply | null>;

export function questionAnswer(question: Question, choice: QuestionChoice): string {
  if ("text" in choice) return choice.text;
  const answer = question.options[choice.option];
  if (answer === undefined) throw new Error("question option is out of range");
  return answer;
}
