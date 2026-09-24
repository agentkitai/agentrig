import { expect, it } from "vitest";
import { shipBuilderCompatibility } from "@agentkitai/agentrig-ship/train-host";

it("legacy routing becomes provider-bound builder/fixer roles, not reviewer routing", () => {
  const compat = shipBuilderCompatibility("sol", ["bash", "read_file", "subagent"]);
  expect(compat.roles.map(role => role.name)).toEqual(["legacy-ship-builder", "legacy-ship-fixer"]);
  for (const role of compat.roles) {
    expect(role.provider).toBe("sol");
    expect(role.tools).toEqual(["bash", "read_file"]);
    expect(role.delegable).toBe(false);
    expect(role.hash).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(compat.warning).toMatch(/builderProvider.*--builder-provider.*deprecated/);
  expect(compat.warning).toContain(".agentrig/agents/<role>.md");
  expect(compat.warning).toContain("provider: sol");
  expect(compat.systemPrompt).toContain('Train builder provider entry: "sol". See ship\'s builder routing rule.');
  expect(compat.systemPrompt).toContain('agent: "legacy-ship-builder"');
  expect(compat.systemPrompt).toContain('agent: "legacy-ship-fixer"');
});
it("ordinary runs have no ship role or prompt contribution", () => {
  expect(shipBuilderCompatibility(undefined, ["bash"])).toEqual({ roles: [] });
});
