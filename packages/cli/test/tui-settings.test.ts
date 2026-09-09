import { expect, it } from "vitest";
import { mapTuiAction, resolveTuiSettings, TuiSettingsSchema } from "../src/tui/settings.js";

it("resolves immutable defaults and two fixed palettes without retaining caller objects", () => {
  const input = { theme: "light" as const, keybindings: { permission: { allowOnce: "Q" } } };
  const resolved = resolveTuiSettings(input); input.keybindings.permission.allowOnce = "x";
  expect(resolved.keybindings.permission.allowOnce).toBe("q");
  expect(Object.isFrozen(resolved)).toBe(true); expect(Object.isFrozen(resolved.palette)).toBe(true);
  expect(Object.isFrozen(resolved.keybindings.permission)).toBe(true);
  expect(resolveTuiSettings().theme).toBe("dark");
  expect(resolveTuiSettings({ keybindings: { permission: { allowOnce: undefined } } }).keybindings.permission.allowOnce).toBe("y");
  expect(resolveTuiSettings().palette.assistant).toBe("white"); expect(resolved.palette.assistant).toBe("black");
});
it.each([
  { theme: "automatic" }, { theme: "dark", arbitrary: true }, { keybindings: { any: "q" } },
  { keybindings: { permission: { allowOnce: "N" } } }, { keybindings: { permission: { allowOnce: "qq" } } },
  { keybindings: { permission: { allowOnce: "é" } } }, { keybindings: { permission: { exit: "q" } } },
  { keybindings: { abort: "ctrl-c" } }, { keybindings: { historyPrevious: "down" } },
])("rejects unknown settings, unsafe keys and collisions after default filling: %j", input => {
  expect(TuiSettingsSchema.safeParse(input).success).toBe(false);
});
it("maps only supported decoded actions and preserves immutable interrupt/escape", () => {
  const settings = resolveTuiSettings({ keybindings: { historyPrevious: "ctrl-p", historyNext: "ctrl-n", abort: "ctrl-g" } });
  expect(mapTuiAction({ type: "append", text: "\u0010" }, settings)).toEqual({ type: "up" });
  expect(mapTuiAction({ type: "append", text: "\u000e" }, settings)).toEqual({ type: "down" });
  expect(mapTuiAction({ type: "append", text: "\u0007" }, settings)).toEqual({ type: "interrupt" });
  expect(mapTuiAction({ type: "up" }, settings)).toBeUndefined();
  expect(mapTuiAction({ type: "interrupt" }, settings)).toEqual({ type: "interrupt" });
  expect(mapTuiAction({ type: "escape" }, settings)).toEqual({ type: "escape" });
});
it("SDK errors explain supported settings without printing unknown keys or values", () => {
  for (const input of [{ CANARY_SECRET_KEY: "CANARY_SECRET_VALUE" }, { theme: "CANARY_SECRET_VALUE" }]) {
    expect(() => resolveTuiSettings(input as never)).toThrow("Invalid TUI settings");
    try { resolveTuiSettings(input as never); } catch (error) { expect(String(error)).not.toContain("CANARY"); }
  }
});
