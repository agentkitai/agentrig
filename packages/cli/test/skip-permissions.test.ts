import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@agentkitai/agentrig-core";
import { buildPermissionPolicy, permissionWarning, skipsPermissions } from "../src/run.ts";

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({
    tool: "bash",
    class: "exec",
    cwd: "/work",
    ...over,
  }) as PermissionRequest;

describe("skipsPermissions", () => {
  it("reads both spellings, so a caller cannot honour one and miss the other", () => {
    expect(skipsPermissions({})).toBe(false);
    expect(skipsPermissions({ yolo: true })).toBe(true);
    expect(skipsPermissions({ dangerouslySkipPermissions: true })).toBe(true);
    expect(skipsPermissions({ yolo: false, dangerouslySkipPermissions: false })).toBe(false);
  });
});

describe("buildPermissionPolicy", () => {
  it("asks about an unmatched call by default", async () => {
    const policy = buildPermissionPolicy({});
    expect(await policy.decide(req())).toBe("ask");
    // a write outside the cwd is the case a prompt exists for
    expect(await policy.decide(req({ tool: "write_file", class: "write", paths: ["/etc/hosts"] }))).toBe("ask");
  });

  it("allows an unmatched call when permissions are skipped", async () => {
    for (const opts of [{ yolo: true }, { dangerouslySkipPermissions: true }]) {
      const policy = buildPermissionPolicy(opts);
      expect(await policy.decide(req()), JSON.stringify(opts)).toBe("allow");
      expect(await policy.decide(req({ tool: "write_file", class: "write", paths: ["/etc/hosts"] }))).toBe("allow");
    }
  });

  it("still honours --deny, because skipping the prompt is not discarding the rules", async () => {
    // `--yolo --deny bash` has to mean something, or the flag is a way to silently lose a rule
    // you asked for. Deny rules are matched first; skipping only changes the fallback.
    const policy = buildPermissionPolicy({ yolo: true, deny: ["bash"] });
    expect(await policy.decide(req())).toBe("deny");
    // and everything else is still allowed
    expect(await policy.decide(req({ tool: "write_file", class: "write", paths: ["/etc/hosts"] }))).toBe("allow");
  });

  it("keeps --deny winning over --allow, skipped or not", async () => {
    for (const extra of [{}, { yolo: true }]) {
      const policy = buildPermissionPolicy({ deny: ["exec"], allow: ["bash"], ...extra });
      expect(await policy.decide(req()), JSON.stringify(extra)).toBe("deny");
    }
  });
});

describe("permissionWarning", () => {
  it("says nothing when permissions are on", () => {
    expect(permissionWarning({}, "/work")).toBeNull();
    expect(permissionWarning({ yolo: false }, "/work")).toBeNull();
  });

  it("names the directory, because 'skip permissions' is abstract and a path is not", () => {
    const w = permissionWarning({ yolo: true }, "/Users/me/project");
    expect(w).not.toBeNull();
    expect(w).toContain("/Users/me/project");
    expect(w).toContain("OFF");
  });

  it("says which rules still apply, so the warning is not misleading", () => {
    const w = permissionWarning({ yolo: true, deny: ["bash", "write:anywhere"] }, "/work");
    expect(w).toContain("bash");
    expect(w).toContain("write:anywhere");
  });
});
