import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProvider } from "../src/provider.ts";
import { buildProgram } from "../src/program.ts";

/**
 * The openai-chatgpt backend rejects `max_output_tokens` outright (verified live: HTTP 400
 * `Unsupported parameter: max_output_tokens`), so the provider does not send it — which makes
 * `--max-tokens-per-turn` a flag the user can set and this provider cannot honour. Accepting a
 * number and quietly ignoring it is the failure mode worth a test.
 */
let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("--max-tokens-per-turn against openai-chatgpt", () => {
  it("says the flag is ignored when the user actually typed it", () => {
    buildProvider({
      provider: "openai-chatgpt",
      model: "gpt-5.6-sol",
      modelExplicit: true,
      maxTokensPerTurnExplicit: true,
    });
    expect(errors.join("\n")).toMatch(/--max-tokens-per-turn is ignored by openai-chatgpt/);
  });

  it("stays quiet about the flag's own default", () => {
    buildProvider({ provider: "openai-chatgpt", model: "gpt-5.6-sol", modelExplicit: true });
    // every run would otherwise carry a warning about a value the user never chose
    expect(errors.join("\n")).not.toMatch(/max-tokens-per-turn/);
    // ...but the experimental-backend warning still stands
    expect(errors.join("\n")).toMatch(/experimental/);
  });

  it("does not warn for providers that honour it", () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    buildProvider({ provider: "anthropic", model: "m", maxTokensPerTurnExplicit: true });
    expect(errors.join("\n")).not.toMatch(/max-tokens-per-turn/);
  });
});

describe("the flag source is what decides", () => {
  it("run reports --max-tokens-per-turn as explicit only when it was passed", () => {
    const typed = buildProgram().commands.find((c) => c.name() === "run")!;
    typed.parseOptions(["--max-tokens-per-turn", "2048"]);
    expect(typed.getOptionValueSource("maxTokensPerTurn")).not.toBe("default");

    const untouched = buildProgram().commands.find((c) => c.name() === "run")!;
    untouched.parseOptions([]);
    expect(untouched.getOptionValueSource("maxTokensPerTurn")).toBe("default");
  });
});
