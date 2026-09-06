import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import { QuestionSchema, QuestionChoiceSchema, questionAnswer, type QuestionHandler } from "@agentkitai/agentrig-core";

const Answers = z.object({ version: z.literal(1), answers: z.array(z.object({
  question: QuestionSchema, answer: QuestionChoiceSchema,
}).strict()).max(16) }).strict();

/** Operator-selected literal file, never an executable or an implicit user reply. */
export async function questionPolicy(policy = "fail"): Promise<QuestionHandler> {
  if (policy === "fail") return async () => null;
  if (policy === "first-option") return async () => ({ source: "first-option", answer: { option: 0 } });
  if (!policy.startsWith("file:") || policy.length <= 5 || policy.length > 4101) throw new Error("--answer-policy must be fail, first-option, or file:<path>");
  const path = policy.slice(5);
  const error = () => new Error("Answer file refused: require stable regular non-symlink UTF-8 JSON, version 1, at most 16 exact question/answer entries and 64 KiB");
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65_536) throw error();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text: string;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw error();
      const buffer = Buffer.alloc(65_537); let size = 0;
      while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      const after = await file.stat(); const current = await lstat(path);
      if (size > 65_536 || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || current.mtimeMs !== before.mtimeMs) throw error();
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await file.close(); }
    const parsed = Answers.parse(JSON.parse(text));
    const answers = new Map<string, z.infer<typeof QuestionChoiceSchema>>();
    for (const entry of parsed.answers) {
      questionAnswer(entry.question, entry.answer);
      const key = JSON.stringify(entry.question);
      if (answers.has(key)) throw error();
      answers.set(key, entry.answer);
    }
    return async request => {
      const answer = answers.get(JSON.stringify({ prompt: request.prompt, options: request.options }));
      return answer === undefined ? null : { source: "file", answer: structuredClone(answer) };
    };
  } catch { throw error(); }
}
