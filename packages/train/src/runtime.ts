/** Public harness adapter; the queue engine itself only consumes TrainRuntime. */
import { MessageSchema } from "@agentkitai/agentrig-core";
import type { TrainRuntime } from "./index.js";
import { trainUsage } from "./train-accounting.js";
export { trainUsage } from "./train-accounting.js";
export { rollupTrainUsage } from "./train-usage.js";
export const harnessTrainRuntime: TrainRuntime = { usage: trainUsage, assistantText(value) {
  const message = MessageSchema.safeParse(value);
  return message.success && message.data.role === "assistant"
    ? message.data.content.filter(block => block.type === "text").map(block => block.text).join("") : undefined;
} };
