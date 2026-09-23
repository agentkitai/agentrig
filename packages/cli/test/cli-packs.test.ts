import { afterEach, expect, it, vi } from "vitest";
import { buildProgram } from "../src/program.js";

// A trusted fixture pack supplies descriptors, never receives a mutable Commander tree.
const fixture = (run = vi.fn()) => ({ name: "fixture", summary: "Fixture pack", commands: [
  { name: "echo", summary: "Echo operands", run },
] });
afterEach(() => vi.unstubAllEnvs());
function program(packs: unknown) {
  vi.stubEnv("AGENTRIG_CHILD_PROFILE", undefined);
  const result = buildProgram({ packs } as Parameters<typeof buildProgram>[0]);
  result.exitOverride();
  result.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return result;
}
it("lists the fixture pack and dispatches literal operands without launching an agent", async () => {
  const run = vi.fn(); const p = program([fixture(run)]);
  expect(p.helpInformation()).toContain("Fixture pack");
  await p.parseAsync(["fixture", "echo", "hello", "--", "--literal"], { from: "user" });
  expect(run).toHaveBeenCalledWith(["hello", "--literal"], expect.objectContaining({ print: expect.any(Function) }));
});
it("joins handler failures rather than swallowing them", async () => {
  const p = program([fixture(async () => { throw new Error("fixture failure"); })]);
  await expect(p.parseAsync(["fixture", "echo"], { from: "user" })).rejects.toThrow("fixture failure");
});
it.each(["run", "tui", "train", "help"])("rejects reserved namespace %s", name => {
  expect(() => program([{ ...fixture(), name }])).toThrow(/reserved|duplicate/);
});
it.each([
  [fixture(), fixture()],
  [{ ...fixture(), commands: [fixture().commands[0], fixture().commands[0]] }],
  [{ ...fixture(), extra: true }],
  [{ ...fixture(), name: "Bad Name" }],
  [{ ...fixture(), commands: [{ name: "echo", summary: "ok", run: "not a function" }] }],
])("rejects invalid descriptors before dispatch", (...packs) => {
  expect(() => program(packs)).toThrow();
});
it("does not accept an unknown option or unknown command", async () => {
  const run = vi.fn();
  await expect(program([fixture(run)]).parseAsync(["fixture", "echo", "--bogus"], { from: "user" })).rejects.toThrow();
  await expect(program([fixture(run)]).parseAsync(["fixture", "missing"], { from: "user" })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it.each([
  { ...fixture(), commands: [] },
  { ...fixture(), summary: "bad\nsummary" },
  { ...fixture(), commands: [{ ...fixture().commands[0], extra: true }] },
  { ...fixture(), commands: [{ ...fixture().commands[0], name: "help" }] },
])("rejects empty or malformed pack command surfaces", pack => {
  expect(() => program([pack])).toThrow();
});
it("awaits successful async handlers", async () => {
  let done = false;
  await program([fixture(async () => { await new Promise(resolve => setTimeout(resolve, 10)); done = true; })])
    .parseAsync(["fixture", "echo"], { from: "user" });
  expect(done).toBe(true);
});
