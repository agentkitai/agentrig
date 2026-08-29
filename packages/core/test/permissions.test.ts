import { describe, expect, it } from "vitest";
import { RulePolicy, defaultRules, type PermissionRequest } from "@agentkitai/agentrig-core";

const req = (tool: string, cls: PermissionRequest["class"], paths?: string[]): PermissionRequest => ({
  tool,
  input: {},
  class: cls,
  cwd: "/w",
  ...(paths === undefined ? {} : { paths }),
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

  it("default rules allow cwd-confined reads and fall back to ask", async () => {
    const policy = new RulePolicy(defaultRules);
    expect(await policy.decide(req("read_file", "read", ["a.txt"]))).toBe("allow");
    expect(await policy.decide(req("read_file", "read", ["/etc/passwd"]))).toBe("ask");
    expect(await policy.decide(req("read_file", "read"))).toBe("ask");
    expect(await policy.decide(req("bash", "exec"))).toBe("ask");
  });

  it("honors a custom fallback", async () => {
    const policy = new RulePolicy([], "deny");
    expect(await policy.decide(req("bash", "exec"))).toBe("deny");
  });

  it("cwdOnly rules match only paths inside the cwd", async () => {
    const policy = new RulePolicy([{ class: "write", cwdOnly: true, decision: "allow" }]);
    expect(await policy.decide(req("write_file", "write", ["a.txt"]))).toBe("allow");
    expect(await policy.decide(req("write_file", "write", ["sub/dir/a.txt", "."]))).toBe("allow");
    expect(await policy.decide(req("write_file", "write", ["/w/inside.txt"]))).toBe("allow");
    expect(await policy.decide(req("write_file", "write", ["../escape.txt"]))).toBe("ask");
    expect(await policy.decide(req("write_file", "write", ["/etc/passwd"]))).toBe("ask");
    expect(await policy.decide(req("write_file", "write", ["a.txt", "../also-escapes"]))).toBe("ask");
  });

  it("cwdOnly rules never match a tool that declares no paths", async () => {
    const policy = new RulePolicy([{ class: "exec", cwdOnly: true, decision: "allow" }]);
    expect(await policy.decide(req("bash", "exec"))).toBe("ask");
  });
});
