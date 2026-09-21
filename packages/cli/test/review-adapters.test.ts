import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// Skill-side JavaScript is exercised directly; no core runtime workflow is introduced.
// @ts-ignore script module has no declaration file
import * as actual from "../../../scripts/review-adapters.mjs";
const adapter = new URL("../../../scripts/review-adapters.mjs", import.meta.url).href;
function run(fn: string, args: unknown[], mutate = "") {
 if (!mutate) {
  try { return {status: 0, stdout: JSON.stringify(actual[fn](...args)), stderr: ""}; }
  catch (error) { return {status: 2, stdout: "", stderr: String(error)}; }
 }
 return spawnSync(process.execPath, ["--input-type=module", "-e", mutate, fn, JSON.stringify(args)], { encoding: "utf8", env: {...process.env, GIT_TRACE2_EVENT: "0"} });
}
const head = "a".repeat(40);
const cli = {name: "primary", adapter: "claude-cli", model: "pin-a"};
const other = {name: "secondary", adapter: "codex-cli", model: "pin-b"};
const json = (model = "pin-a", result = `Reviewed head ${head}\nPASS`) => JSON.stringify({modelUsage: {[model]: {}}, result, is_error: false});
it("asserts CLI JSON and banner provenance against exact pin", () => {
 expect(run("assertCliResult", [cli, json()]).status).toBe(0);
 expect(run("assertCliResult", [other, "PASS", "model: pin-b\r\n"]).status).toBe(0);
});
for (const [name, args] of [
 ["wrong JSON model", [cli, json("wrong")]], ["empty JSON", [cli, json("pin-a", " ")]],
 ["missing usage", [cli, '{"result":"PASS"}']], ["ambiguous usage", [cli, '{"modelUsage":{"pin-a":{},"other":{}},"result":"PASS"}']],
 ["failed JSON", [cli, '{"is_error":true,"result":"PASS","modelUsage":{"pin-a":{}}}']],
 ["malformed JSON", [cli, "not JSON"]], ["failed exit", [cli, json(), "", 1]],
 ["missing banner", [other, "PASS", ""]], ["wrong banner model", [other, "PASS", "model: wrong"]],
 ["duplicate banner", [other, "PASS", "model: pin-b\nmodel: pin-b"]],
 ["empty stdout", [other, "  ", "model: pin-b"]], ["error banner", [other, "PASS", "model: pin-b\nERROR: failed"]],
 ["failed other exit", [other, "PASS", "model: pin-b", 1]],
] as const) it(`fails closed on ${name}`, () => expect(run("assertCliResult", [...args]).status).toBe(2));
for (const claim of [`head ${"a".repeat(41)}`, `head_sha: ${"c".repeat(40)}`, `Reviewed at ${"c".repeat(40)}`, "Reviewed head HEAD", `## External review — slot — head ${"c".repeat(40)}\nReviewed head ${head}`, `Reviewed head ${head}\nPreviously reviewed commit ${"c".repeat(40)} had a bug`]) it(`M-claim rejects ${claim}`, () => expect(run("validateVerdict", [claim + "\nPASS", head]).status).toBe(2));
for (const body of ["", "PASS", `## External review — primary — head ${head}\n\n`, `## Head ${head}\n# PASS`]) it(`rejects missing claim or empty verdict ${body}`, () => expect(run("validateVerdict", [body, head]).status).toBe(2));
it("permits full and abbreviated matching claims including markdown", () => expect(run("validateVerdict", [`head_sha: ${head}\nReviewed at \`${head.slice(0, 7)}\`\nPASS`, head]).status).toBe(0));
for (const [profile, count] of [[undefined, 2], ["one", 1], ["none", 0]] as const) it(`API fixture ${count} slots resolves named routing without defaults`, () => {
 const config = new URL("./fixtures/reviewers.json", import.meta.url).pathname;
 const source = `import {declaredSlots,describe} from ${JSON.stringify(adapter)};const {slots,providers}=declaredSlots(${JSON.stringify(config)},${JSON.stringify(profile)}); console.log(JSON.stringify(slots.map(s=>describe(s,providers))));`;
 const result = run("", [], source); expect(result.status, result.stderr).toBe(0);
 const slots = JSON.parse(result.stdout); expect(slots).toHaveLength(count);
 for (const slot of slots) { expect(slot.adapter).toBe("api"); expect(slot.provider).toBeTruthy(); expect(slot.launch).toContain("roles.main references slot.provider"); expect(slot).not.toHaveProperty("baseUrl"); }
});
for (const [name, before, after, fn, args] of [
 ["M-pin-assertion", "if (model !== slot.model)", "if (false)", "assertCliResult", [cli, json("wrong")]],
 ["M-empty-verdict", "if (typeof verdict !== \"string\" || verdict.trim().length === 0)", "if (false)", "assertCliResult", [cli, json("pin-a", "")]],
 ["M-41hex-grammar", "[0-9a-f]{7,}", "[0-9a-f]{7,40}", "validateVerdict", [`Reviewed head ${head}\nhead ${"a".repeat(41)}\nPASS`, head]],
] as const) it(`${name} copy-only mutant is killed by the same witness`, () => {
 expect(run(fn, [...args]).status).toBe(2);
 const source = readFileSync(new URL(adapter), "utf8"); expect(source).toContain(before);
 const altered = source.replace(before, after).replace('"../packages/cli/dist/config.js"', JSON.stringify(new URL("../dist/config.js", import.meta.url).href));
 const mutant = `data:text/javascript;base64,${Buffer.from(altered).toString("base64")}`;
 const invoke = `import * as a from ${JSON.stringify(mutant)}; try { a[process.argv[1]](...JSON.parse(process.argv[2])); } catch { process.exitCode=2; }`;
 expect(run(fn, [...args], invoke).status).toBe(0);
});
it("absent config has zero slots; unknown profiles are not inherited properties", () => {
 const absent = new URL("./fixtures/no-review-config.json", import.meta.url).pathname;
 const result = run("declaredSlots", [absent]);
 expect(result.status).toBe(0); expect(JSON.parse(result.stdout).slots).toEqual([]);
 expect(run("declaredSlots", [absent, "constructor"]).status).toBe(2);
});
it("API provider pin mismatch is rejected, no silent routing fallback", () => expect(run("describe", [{name:"x",adapter:"api",provider:"one",model:"pin"},{one:{model:"other"}}]).status).toBe(2));
