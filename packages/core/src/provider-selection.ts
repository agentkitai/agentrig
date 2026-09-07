import { z } from "zod";
import { REASONING_EFFORTS, type ModelProvider } from "./provider.js";

const name = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const ProviderSelectionInfoSchema = z.object({ entry: name, provider: name, model: name,
  effort: z.enum(REASONING_EFFORTS).optional() }).strict();
export type ProviderSelectionInfo = z.infer<typeof ProviderSelectionInfoSchema>;
export interface ProviderSelection { provider: ModelProvider; entry: string; effort?: ProviderSelectionInfo["effort"] }
