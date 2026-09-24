import { trainCommand, type TrainCommand } from "@agentkitai/agentrig-core";
import { trainGithubCommand as decorate } from "@agentkitai/agentrig-ship/train-github";

/** Compatibility entrypoint; bounded transport policy belongs to the ship pack. */
export function trainGithubCommand(command: TrainCommand = trainCommand, options: Parameters<typeof decorate>[1] = {}): TrainCommand {
  return decorate(command, options);
}
