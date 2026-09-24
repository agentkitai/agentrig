/** Transitional R19d facade. CLI/core consumers keep their existing entrypoints. */
import { createTrain } from "@agentkitai/agentrig-train";
import { shipTrainStages } from "@agentkitai/agentrig-ship/train";
import { MessageSchema } from "./messages.js";
import { trainUsage } from "./train-accounting.js";
export { TrainRowSchema } from "@agentkitai/agentrig-train";
export type { TrainRow, TrainRequest, TrainCommand, TrainStatus, TrainOptions } from "@agentkitai/agentrig-train";
export { trainUsage };
const train = createTrain({ usage: trainUsage, assistantText(value) {
  const message = MessageSchema.safeParse(value);
  if (message.success && message.data.role === "assistant") return message.data.content.filter(block => block.type === "text").map(block => block.text).join("");
  return undefined;
} }, shipTrainStages);
export const { runTrain, trainStatus, trainCommand } = train;
