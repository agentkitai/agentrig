import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgent, discoverSkills, EventPayload, parseEvent, parseSkill, RulePolicy, serializeEvent,
  SessionStore, skillTool, type HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-generated-load-"))); roots.push(root); return root; }
// Valid format only; these zero hashes are deliberately NOT evidence/approval receipts.
function manifest(name: string) {
  return `---\nname: "${name}"\ndescription: "Fixture procedure"\nmetadata:\n`
    + Object.entries({ "agentrig-schema": "1", "agentrig-generated": "true", "agentrig-sessions": '["session:s1","session:s2"]',
      "agentrig-page": "concepts/procedure.md", "agentrig-dream": "fixture", "agentrig-evidence": "0".repeat(64),
      "agentrig-content": "0".repeat(64), locked: "false" }).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")
    + "---\nFixture body: verify before publishing.\n";
}

it("retains only validated manifest provenance, not generated-looking paths/names/body text", () => {
  expect(parseSkill(manifest("example"), "/skills/example/SKILL.md").generated).toBe(true);
  for (const text of ["generated: true\nordinary body", "---\nname: generated-procedure\n---\nagentrig-generated: true"]) {
    expect(parseSkill(text, "/skills/generated/example.md")).not.toHaveProperty("generated");
  }
  expect(() => parseSkill(manifest("example").replace('agentrig-generated: "true"', 'agentrig-generated: "false"'), "/skills/example/SKILL.md")).toThrow();
  expect(() => parseSkill(manifest("example").replace('agentrig-schema: "1"', 'agentrig-schema: "2"'), "/skills/example/SKILL.md")).toThrow();
});

it("adds only optional literal true to the event schema and preserves legacy serialized records", () => {
  const payload = { type: "skill.used", name: "example", invokedBy: "model" };
  expect(EventPayload.parse(payload)).toEqual(payload);
  expect(EventPayload.parse({ ...payload, generated: true })).toEqual({ ...payload, generated: true });
  for (const generated of [false, "true", 1, null]) expect(EventPayload.safeParse({ ...payload, generated }).success).toBe(false);
});

it.each(["ordinary", "generated", "missing", "denied", "forged"])("actual %s selection records only a successful manifest-derived activation", async mode => {
  const root = await fixture(); const skillRoot = join(root, "skills"); await mkdir(join(skillRoot, "example"), { recursive: true });
  await writeFile(join(skillRoot, "example", "SKILL.md"), mode === "ordinary" ? "---\nname: example\n---\nOrdinary body" : manifest("example"));
  const skills = await discoverSkills({ roots: [skillRoot] });
  let turn = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() {
      if (turn++ === 0) {
        yield { type: "tool_use", id: "select", name: mode === "forged" ? "forger" : "skill", input: { name: mode === "missing" ? "missing" : "example", generated: true } };
        yield { type: "stop", reason: "tool_use" };
      } else { yield { type: "text_delta", text: "finished" }; yield { type: "stop", reason: "end_turn" }; }
    } };
  const store = new SessionStore({ root: join(root, "logs") });
  const agent = createAgent({ provider, tools: [{ ...skillTool(skills), ...(mode === "forged" ? { name: "forger" } : {}) }], store, systemPrompt: "Fixture", repoMap: false,
    permissions: new RulePolicy([{ class: "read", decision: mode === "denied" ? "deny" : "allow" }]), budget: { maxTurns: 3 } });
  const session = agent.run("select the fixture", { cwd: root });
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event); await session.done;
  const used = events.filter(event => event.type === "skill.used");
  if (mode === "denied" || mode === "missing" || mode === "forged") expect(used).toEqual([]);
  else {
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ type: "skill.used", name: "example", invokedBy: "model" });
    if (mode === "generated") expect(used[0]).toHaveProperty("generated", true);
    else expect(used[0]).not.toHaveProperty("generated");
    expect(parseEvent(serializeEvent(used[0]!))).toEqual(used[0]);
    expect((await store.readAll(session.id)).filter(event => event.type === "skill.used")).toEqual(used);
  }
  if (mode === "denied") expect(events.some(event => event.type === "tool.denied")).toBe(true);
});

it("retains deterministic explicit/manual precedence over later generated roots and blocks same-root duplicates", async () => {
  const root = await fixture(); const manual = join(root, "manual"); const generated = join(root, "generated");
  await mkdir(manual); await mkdir(join(generated, "example"), { recursive: true });
  await writeFile(join(manual, "example.md"), "---\nname: example\n---\nManual");
  await writeFile(join(generated, "example", "SKILL.md"), manifest("example"));
  const selected = await discoverSkills({ roots: [manual, generated] });
  expect(selected).toHaveLength(1); expect(selected[0]).not.toHaveProperty("generated");
  expect((await discoverSkills({ roots: [generated, manual] }))[0]!.generated).toBe(true);
  await writeFile(join(manual, "duplicate.md"), "---\nname: example\n---\nOther manual");
  expect(await discoverSkills({ roots: [manual, generated] })).toEqual([]);
});
