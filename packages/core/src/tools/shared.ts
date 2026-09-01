import { isAbsolute, resolve } from "node:path";

/** Cap tool output shown to the model. */
export const DISPLAY_CAP = 30_000;

export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

export function safeSliceEnd(text: string, proposed: number): number {
  return splitsSurrogatePair(text, proposed) ? proposed - 1 : proposed;
}

export function bound(text: string, cap = DISPLAY_CAP): { display: string; truncated: boolean } {
  if (text.length <= cap) return { display: text, truncated: false };
  let visible = cap;
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `\n… [truncated ${text.length - visible} UTF-16 code units]`;
    const next = safeSliceEnd(text, Math.max(0, cap - marker.length));
    if (next === visible) break;
    visible = next;
  }
  marker = `\n… [truncated ${text.length - visible} UTF-16 code units]`;
  return { display: `${text.slice(0, visible)}${marker}`.slice(0, cap), truncated: true };
}

export function resolveIn(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
