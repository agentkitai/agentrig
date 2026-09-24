import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("historical #313 status links CI staleness to the existing shipping section", () => {
  const status = readFileSync(new URL("../../../docs/STATUS.md", import.meta.url), "utf8");
  const section = status.match(/^## Historical MAIN in rerun matching — issue #313[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1];
  expect(section).toBeDefined();
  expect(section).toContain("CI staleness");
  expect(section).toContain("[SHIPPING-WORKFLOW §1](SHIPPING-WORKFLOW.md#1-ci-and-review-are-independent-tracks)");
  const shipping = readFileSync(new URL("../../../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8");
  expect(shipping).toMatch(/^## 1\. CI and review are independent tracks$/m);
});
