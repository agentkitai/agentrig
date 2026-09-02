import { describe, expect, it } from "vitest";
import { SandboxDeniedError, SandboxMode } from "@agentkitai/agentrig-core";

describe("sandbox provider contract", () => {
  it("accepts exactly the three roadmap modes", () => {
    expect(SandboxMode.options).toEqual(["read-only", "workspace-write", "none"]);
    expect(SandboxMode.safeParse("full-access").success).toBe(false);
  });

  it("marks only explicit provider denials for the agent boundary", () => {
    const denial = new SandboxDeniedError("operation not permitted", { cause: new Error("EPERM") });
    expect(denial).toBeInstanceOf(Error);
    expect(denial.name).toBe("SandboxDeniedError");
    expect(denial.message).toBe("operation not permitted");
    expect(denial.cause).toBeInstanceOf(Error);
  });
});
