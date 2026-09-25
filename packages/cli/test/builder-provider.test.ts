import { expect, it } from "vitest";
import { builderProviderContext } from "../src/builder-provider.js";
it("validates run hints without mutating any role and leaves omission unchanged", () => {
  const options = { providers: { sol: { provider: "openai", model: "fixture" } }, roles: { main: "default", subagents: "default" } };
  const before = JSON.stringify(options);
  expect(builderProviderContext(undefined, options)).toEqual([]);
  expect(builderProviderContext("sol", options).join(" ")).toContain('builderProvider="sol"');
  expect(builderProviderContext("default", options)).toHaveLength(1);
  expect(JSON.stringify(options)).toBe(before);
  for (const value of ["missing", "constructor", "", " ", "sol\r\n", "sol\"", "x".repeat(129)]) expect(() => builderProviderContext(value, options)).toThrow();
});
