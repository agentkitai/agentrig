import { createTrain } from "@agentkitai/agentrig-train";
import { harnessTrainRuntime, trainUsage } from "@agentkitai/agentrig-train/runtime";
import { shipTrainStages } from "@agentkitai/agentrig-ship/train";
import * as cli from "../packages/cli/src/train.js";
export const packageTrain = createTrain(harnessTrainRuntime, shipTrainStages);
export const trainPaths = [{ name: "CLI composition", ...cli, trainUsage }, { name: "train package + ship stages", ...packageTrain }];
