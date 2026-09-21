import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

it.each(["ship", "topic"])("%s resumes recorded phases without re-orientation or invented authority", async skill => {
  const text = await readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  const section = text.split("## Resuming")[1]?.split("\n## ")[0]?.replace(/\s+/g, " ") ?? "";
  for (const phrase of ["agentrig run --resume <session>", "same session", "Do not repeat recorded re-orientation", "Repair round", "read-back receipts", "current PR head", "before any further work", "ran / handed off / died", "does not consume another repair round", "Do not spawn a second builder", "before builder", "after handoff", "mid repair round", "awaiting reviews", "awaiting landing", "scope, authorization, trust and denies"]) expect(section).toContain(phrase);
});
