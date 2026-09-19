import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("disables host Git trace2 hooks in the test process", () => {
  expect(process.env.GIT_TRACE2_EVENT).toBe("0");
});

it("disables host Git trace2 hooks in inherited Git children", () => {
  // A Git shell alias reports the environment inherited through Git, without a fixture repo.
  const inherited = execFileSync("git", [
    "-c", "alias.trace-env=!printf '%s' \"$GIT_TRACE2_EVENT\"",
    "trace-env",
  ], { encoding: "utf8" });
  expect(inherited).toBe("0");
});
