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

it("keeps the inclusive 64-tool role limit", () => {
  const tools = Array.from({ length: 64 }, (_, i) => `tool_${i}`);
  expect(shipBuilderCompatibility("sol", tools).roles.map(role => role.tools)).toEqual([tools, tools]);
});
it.each([65, 256])("preserves oversized legacy tool catalogs (%s) via explicit provider fallback", count => {
  const compat = shipBuilderCompatibility("sol", Array.from({ length: count }, (_, i) => `tool_${i}`));
  expect(compat.roles).toEqual([]);
  expect(compat.warning).toContain("64 tools");
  expect(compat.systemPrompt).toContain('provider: "sol"');
  expect(compat.systemPrompt).not.toContain('agent: "legacy-ship');
});
it("allocates collision-free names and teaches the exact bindings without shadowing", () => {
  const occupied = ["legacy-ship-builder", "legacy-ship-builder-1", "legacy-ship-fixer"];
  const compat = shipBuilderCompatibility("sol", ["bash"], occupied);
  expect(compat.roles.map(role => role.name)).toEqual(["legacy-ship-builder-2", "legacy-ship-fixer-1"]);
  for (const role of compat.roles) {
    expect(occupied).not.toContain(role.name);
    expect(compat.systemPrompt).toContain(`agent: "${role.name}"`);
  }
});
it.each([30, 31, 32])("preserves the discovered role catalog at %s entries", count => {
  const compat = shipBuilderCompatibility("sol", ["bash"], Array.from({ length: count }, (_, i) => `role-${i}`));
  expect(compat.roles).toHaveLength(count === 30 ? 2 : 0);
  if (count > 30) {
    expect(compat.warning).toContain("32 roles");
    expect(compat.systemPrompt).toContain('provider: "sol"');
  }
});
