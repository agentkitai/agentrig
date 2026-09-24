import { expect, it } from "vitest";
import { defaultSystemPrompt } from "../src/run.js";

it("default prompt has no shipping authorization or delivery clause", () => {
  const prompt = defaultSystemPrompt("/project");
  expect(prompt).not.toContain("merge authorization");
  expect(prompt).not.toContain("delivery when authorized");
  expect(prompt).toContain("Verify your work");
});
