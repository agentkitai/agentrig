import { createTrain } from "@agentkitai/agentrig-train";
import { shipTrainStages } from "@agentkitai/agentrig-ship/train";
import * as core from "@agentkitai/agentrig-core";
// Independent public composition, not a second alias to the core facade.
export const packageTrain = createTrain({ usage: core.trainUsage, assistantText(value) {
  const message = core.MessageSchema.safeParse(value);
  return message.success && message.data.role === "assistant"
    ? message.data.content.map(block => block.type === "text" ? block.text : "").join("") : undefined;
} }, shipTrainStages);
export const trainPaths = [{ name: "core compatibility", ...core }, { name: "train package + ship stages", ...packageTrain }];
