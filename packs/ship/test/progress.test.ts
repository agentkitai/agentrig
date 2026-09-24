import { expect, it } from "vitest";
import { shippingProgressPatterns } from "../src/progress.js";

it.each(["git add .", "git commit -m done", "git push origin task", "gh pr create", "gh pr merge 1", "gh pr ready", "gh pr edit", "gh pr comment", "cd repo && git push"])("shipping policy retains progress for %s", command => {
  expect(shippingProgressPatterns.some(pattern => new RegExp(pattern).test(command))).toBe(true);
});
it.each(["git status", "gh pr view", "gh run list", "git log"])("shipping policy does not exempt %s", command => {
  expect(shippingProgressPatterns.some(pattern => new RegExp(pattern).test(command))).toBe(false);
});
