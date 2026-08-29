import { isAbsolute, resolve } from "node:path";

/** Cap tool output shown to the model. */
export const DISPLAY_CAP = 30_000;

export function bound(text: string, cap = DISPLAY_CAP): { display: string; truncated: boolean } {
  if (text.length <= cap) return { display: text, truncated: false };
  return { display: `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`, truncated: true };
}

export function resolveIn(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
