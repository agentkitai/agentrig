import { describe, expect, it } from "vitest";
import { RulePolicy, defaultRules, type PermissionRequest } from "@agentkitai/agentrig-core";

const req = (tool: string, cls: PermissionRequest["class"]): PermissionRequest => ({
  tool,
  input: {},
  class: cls,
  cwd: "/w",
});

describe("RulePolicy", () => {
  it("first matching rule wins", async () => {
    const policy = new RulePolicy([
      { tool: "bash", decision: "deny" },
      { class: "exec", decision: "allow" },
    ]);
    expect(await policy.decide(req("bash", "exec"))).toBe("deny");
    expect(await policy.decide(req("other_exec", "exec"))).toBe("allow");
  });

  it("matches on class, tool name, or wildcard", async () => {
    const policy = new RulePolicy([
      { class: "read", decision: "allow" },
      { tool: "write_file", decision: "allow" },
      { tool: "*", class: "network", decision: "deny" },
    ]);
    expect(await policy.decide(req("grep", "read"))).toBe("allow");
    expect(await policy.decide(req("write_file", "write"))).toBe("allow");
    expect(await policy.decide(req("fetch", "network"))).toBe("deny");
  });

  it("falls back to ask by default", async () => {
    const policy = new RulePolicy(defaultRules);
    expect(await policy.decide(req("read_file", "read"))).toBe("allow");
    expect(await policy.decide(req("bash", "exec"))).toBe("ask");
  });

  it("honors a custom fallback", async () => {
    const policy = new RulePolicy([], "deny");
    expect(await policy.decide(req("bash", "exec"))).toBe("deny");
  });
});
