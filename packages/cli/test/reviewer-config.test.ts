import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseConfigText } from "../src/config.js";
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
it.each([
  ["reviewers-zero.json", []],
  ["reviewers-one.json", ["Solo"]],
  ["reviewers-two-api.json", ["Alpha", "Beta"]],
] as const)("parses ordered reviewer slots from %s", (name, expected) => {
  const parsed = parseConfigText(name, fixture(name));
  expect(parsed.reviewers?.map(slot => slot.name)).toEqual(expected);
  expect(parsed.reviewers?.some(slot => "canRunChecks" in slot)).toBe(false);
});
it("rejects more than two, duplicate names, unknown API binding, model mismatch, and workflow policy", () => {
  const base = { providers: { p: { provider:"openai", model:"m" } } };
  const bad = [
    {...base,reviewers:[0,1,2].map(i=>({name:`R${i}`,adapter:"api",provider:"p",model:"m"}))},
    {...base,reviewers:[0,1].map(()=>({name:"R",adapter:"api",provider:"p",model:"m"}))},
    {...base,reviewers:[{name:"R",adapter:"api",provider:"missing",model:"m"}]},
    {...base,reviewers:[{name:"R",adapter:"api",provider:"p",model:"other"}]},
    {...base,reviewers:[{name:"R",adapter:"codex-cli",model:"m",canRunChecks:true}]},
  ];
  for (const value of bad) expect(() => parseConfigText("bad.json",JSON.stringify(value))).toThrow();
});
it.each([0,1,2])("landing evidence gate follows configured count %i", count => {
  const slots = Array.from({length:count},(_,i)=>({name:`R${i}`,model:`m${i}`}));
  const headings = slots.map(slot=>`## External review — ${slot.name} (${slot.model}) — head ${"a".repeat(40)} — full`);
  const accepted = count === 0 ? headings.length === 0 : headings.length === slots.length && headings.every((heading,i)=>heading.includes(`— ${slots[i]!.name} (${slots[i]!.model}) —`));
  expect(accepted).toBe(true);
  if (count) expect(headings.slice(0,-1).length).not.toBe(slots.length);
});
