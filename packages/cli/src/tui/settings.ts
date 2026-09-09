import { z } from "zod";
import type { OrdinaryInputAction } from "./input-buffer.js";

const letter = z.string().regex(/^[a-zA-Z]$/, "one ASCII letter required");
const historyKey = z.enum(["up", "down", "ctrl-p", "ctrl-n"]);
const permissionDefaults = Object.freeze({ allowOnce: "y", denyOnce: "n", allowSession: "a", denySession: "d", scope: "s", editScope: "e" });
function permissionKeys(input?: Partial<Record<keyof typeof permissionDefaults, string | undefined>>) {
  return Object.fromEntries(Object.entries(permissionDefaults).map(([name, fallback]) =>
    [name, (input?.[name as keyof typeof permissionDefaults] ?? fallback).toLowerCase()])) as Record<keyof typeof permissionDefaults, string>;
}
export const TuiSettingsSchema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  keybindings: z.object({
    permission: z.object({ allowOnce: letter.optional(), denyOnce: letter.optional(), allowSession: letter.optional(),
      denySession: letter.optional(), scope: letter.optional(), editScope: letter.optional() }).strict().optional(),
    historyPrevious: historyKey.optional(), historyNext: historyKey.optional(), abort: z.literal("ctrl-g").optional(),
  }).strict().optional(),
}).strict().superRefine((settings, ctx) => {
  const permission = permissionKeys(settings.keybindings?.permission);
  if (new Set(Object.values(permission).map(value => value.toLowerCase())).size !== 6)
    ctx.addIssue({ code: "custom", path: ["keybindings", "permission"], message: "permission keys must be unique ignoring case after defaults" });
  if ((settings.keybindings?.historyPrevious ?? "up") === (settings.keybindings?.historyNext ?? "down"))
    ctx.addIssue({ code: "custom", path: ["keybindings"], message: "history keys must be distinct after defaults" });
});
export type TuiSettings = z.input<typeof TuiSettingsSchema>;
/** Fixed SDK/startup diagnostic; schema details may contain untrusted unknown field names. */
export function parseTuiSettings(input?: TuiSettings): TuiSettings {
  const parsed = TuiSettingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw new Error("Invalid TUI settings. Use theme dark/light, unique single-letter permission keys, distinct up/down/ctrl-p/ctrl-n history keys, and optional ctrl-g abort.");
  return parsed.data;
}
const palettes = Object.freeze({
  dark: Object.freeze({ event: "gray", you: "cyan", system: "gray", assistant: "white", error: "red", prompt: "green", status: "gray", warning: "yellow" }),
  light: Object.freeze({ event: "black", you: "blue", system: "black", assistant: "black", error: "red", prompt: "blue", status: "black", warning: "magenta" }),
});
export function resolveTuiSettings(input?: TuiSettings) {
  const parsed = parseTuiSettings(input), theme = parsed.theme ?? "dark";
  return Object.freeze({ theme, palette: palettes[theme], keybindings: Object.freeze({
    permission: Object.freeze(permissionKeys(parsed.keybindings?.permission)),
    historyPrevious: parsed.keybindings?.historyPrevious ?? "up", historyNext: parsed.keybindings?.historyNext ?? "down",
    ...(parsed.keybindings?.abort === undefined ? {} : { abort: parsed.keybindings.abort }),
  }) });
}
export type ResolvedTuiSettings = ReturnType<typeof resolveTuiSettings>;

/** Only decoded non-pasted actions enter this mapping; authority decisions remain in controller. */
export function mapTuiAction(action: OrdinaryInputAction, settings: ResolvedTuiSettings): OrdinaryInputAction | undefined {
  const key = action.type === "up" || action.type === "down" ? action.type : action.type === "append"
    ? ({ "\u0010": "ctrl-p", "\u000e": "ctrl-n", "\u0007": "ctrl-g" } as Record<string, string>)[action.text] : undefined;
  if (key === undefined) return action;
  if (key === settings.keybindings.historyPrevious) return { type: "up" };
  if (key === settings.keybindings.historyNext) return { type: "down" };
  if (key === "ctrl-g" && settings.keybindings.abort === "ctrl-g") return { type: "interrupt" };
  return undefined;
}
