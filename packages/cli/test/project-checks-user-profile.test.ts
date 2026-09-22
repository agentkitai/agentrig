import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectChecks } from "../src/project-checks.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const projectChecks = { bootstrap: "project setup", steps: [{ name: "unit", command: "project test" }] };
const userChecks = { bootstrap: "USER MUST NOT RUN", steps: [] };
async function fixture(unsafeHome = false) {
  const root = await mkdtemp(join(tmpdir(), "checks-user-profile-")); roots.push(root);
  const checkout = join(root, "checkout");
  const home = unsafeHome ? join(checkout, "home") : join(root, "home");
  await mkdir(join(home, ".agentrig"), { recursive: true });
  await mkdir(join(checkout, ".git"), { recursive: true });
  await mkdir(join(checkout, ".agentrig"));
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  const userPath = join(home, ".agentrig/config.json"), projectPath = join(checkout, ".agentrig/config.json");
  await writeFile(userPath, JSON.stringify({ checks: userChecks, profiles: { personal: { checks: userChecks } } }));
  await writeFile(projectPath, JSON.stringify({ checks: projectChecks }));
  return { checkout, userPath, projectPath };
}
it("accepts a profile declared ONLY in user config through the public two-argument resolver", async () => {
  const { checkout } = await fixture();
  expect(await resolveProjectChecks(checkout, "personal")).toEqual(projectChecks);
});
it("keeps all commands project-owned, including project profile replacement and missing declarations", async () => {
  const { checkout, projectPath } = await fixture();
  expect(await resolveProjectChecks(checkout)).toEqual(projectChecks);
  const replacement = { bootstrap: "project profile setup", steps: [] };
  await writeFile(projectPath, JSON.stringify({ checks: projectChecks, profiles: { personal: { checks: replacement } } }));
  expect(await resolveProjectChecks(checkout, "personal")).toEqual(replacement);
  await writeFile(projectPath, "{}");
  expect(await resolveProjectChecks(checkout, "personal")).toBeUndefined();
  await rm(projectPath);
  expect(await resolveProjectChecks(checkout, "personal")).toBeUndefined();
});
it("rejects unknown profiles and malformed safe user config", async () => {
  const { checkout, userPath } = await fixture();
  await expect(resolveProjectChecks(checkout, "missing")).rejects.toThrow("unknown config profile");
  await writeFile(userPath, "{");
  await expect(resolveProjectChecks(checkout, "personal")).rejects.toThrow();
});
it("never loads a repository-controlled home as user profile authority", async () => {
  const { checkout, userPath } = await fixture(true);
  await expect(resolveProjectChecks(checkout, "personal")).rejects.toThrow("unknown config profile");
  await writeFile(userPath, "{");
  expect(await resolveProjectChecks(checkout)).toEqual(projectChecks);
});
it("retains explicit user configuration injection without reading the ambient home", async () => {
  const { checkout, userPath } = await fixture();
  await writeFile(userPath, "{");
  expect(await resolveProjectChecks(checkout, "injected", { profiles: { injected: {} } })).toEqual(projectChecks);
  await expect(resolveProjectChecks(checkout, "personal", {})).rejects.toThrow("unknown config profile");
});
