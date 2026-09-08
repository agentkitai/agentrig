import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

interface Marker { path: string; kind: string; detail?: string }
interface Inspection { temporaryDirectory: string; probed: string[]; markers: Marker[] }
type Lstat = (path: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>;
const { inspectTemporaryRoot: inspectRoot, preflightFailure } = await import(
  new URL("../../../test/fixture-preflight.mjs", import.meta.url).href) as {
    inspectTemporaryRoot(temporaryDirectory: string, lstat?: Lstat, realpath?: (path: string) => Promise<string>): Promise<Inspection>;
    preflightFailure(inspection: Inspection): string | undefined;
  };
const inspectTemporaryRoot = (directory: string, lstat: Lstat) => inspectRoot(directory, lstat, async path => resolve(path));

const script = fileURLToPath(new URL("../../../test/fixture-preflight.mjs", import.meta.url));
const chain = (...directories: string[]) => directories.map(directory => join(resolve(directory), ".git"));
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
/** Deterministic ancestry: no host directory decides what these cases see. */
const ancestry = (markers: Record<string, Partial<Record<"symlink" | "directory" | "file", true>> | Error>): Lstat =>
  async path => {
    const entry = markers[path];
    if (entry === undefined) throw enoent();
    if (entry instanceof Error) throw entry;
    return { isSymbolicLink: () => entry.symlink === true, isDirectory: () => entry.directory === true, isFile: () => entry.file === true };
  };

it("probes .git at the effective temporary directory and every ancestor up to the filesystem root", async () => {
  const inspection = await inspectTemporaryRoot("/tmp/fixture", ancestry({}));
  expect(inspection.probed).toEqual(chain("/tmp/fixture", "/tmp", "/"));
  expect(inspection.temporaryDirectory).toBe(resolve("/tmp/fixture"));
  expect(inspection.markers).toEqual([]);
  expect(preflightFailure(inspection)).toBeUndefined();
});

it.each([["directory", { directory: true as const }], ["file", { file: true as const }], ["symlink", { symlink: true as const }]])(
  "reports an ancestor .git %s", async (kind, entry) => {
    const marker = join(resolve("/tmp"), ".git");
    const inspection = await inspectTemporaryRoot("/tmp/fixture", ancestry({ [marker]: entry }));
    expect(inspection.markers).toEqual([{ path: marker, kind }]);
    expect(preflightFailure(inspection)).toContain(`${marker} (${kind})`);
  });

it("treats a marker it cannot read as present rather than absent", async () => {
  const marker = join(resolve("/tmp"), ".git");
  const inspection = await inspectTemporaryRoot("/tmp/fixture", ancestry({ [marker]: Object.assign(new Error("denied"), { code: "EACCES" }) }));
  expect(inspection.markers).toEqual([{ path: marker, kind: "unreadable", detail: "EACCES" }]);
  expect(preflightFailure(inspection)).toContain(`${marker} (unreadable: EACCES)`);
});

it("names every marker in the chain and says what cannot hold and what not to do", async () => {
  const [near, far] = chain("/tmp/fixture", "/tmp");
  const failure = preflightFailure(await inspectTemporaryRoot("/tmp/fixture",
    ancestry({ [near!]: { directory: true }, [far!]: { file: true } })));
  expect(failure).toContain(near!);
  expect(failure).toContain(far!);
  expect(failure).toMatch(/not a product defect/);
  expect(failure).toMatch(/[Dd]o not delete/);
  expect(failure).toContain("docs/TESTING.md");
});

it("exits non-zero from the real script when the effective temporary root inherits a Git marker", async () => {
  const base = await mkdtemp(join(tmpdir(), "agentrig-preflight-"));
  try {
    await mkdir(join(base, ".git"));
    const work = join(base, "work");
    await mkdir(work);
    const failure = await promisify(execFile)(process.execPath, [script],
      { env: { ...process.env, TMPDIR: work, TEMP: work, TMP: work }, timeout: 60_000 },
    ).then(() => undefined, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toBe("");
    expect(failure?.stderr).toContain(join(base, ".git"));
    expect(failure?.stderr).toContain(work);
  } finally { await rm(base, { recursive: true, force: true }); }
}, 70_000);

it("guards `pnpm test` with the same script it exposes as `pnpm test:preflight`", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(scripts.test).toBe("node test/fixture-preflight.mjs && vitest run");
  expect(scripts["test:preflight"]).toBe("node test/fixture-preflight.mjs --verbose");
});

it("checks physical ancestry when the effective temporary directory is a symlink", async () => {
  const base = await mkdtemp(join(tmpdir(), "agentrig-preflight-link-"));
  try {
    const physical = join(base, "physical"), work = join(physical, "work"), alias = join(base, "alias");
    await mkdir(work, { recursive: true }); await mkdir(join(physical, ".git"));
    await symlink(work, alias, process.platform === "win32" ? "junction" : "dir");
    const failure = await promisify(execFile)(process.execPath, [script],
      { env: { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias }, timeout: 60_000 },
    ).then(() => undefined, (error: { code: number; stderr: string }) => error);
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain(join(physical, ".git"));
  } finally { await rm(base, { recursive: true, force: true }); }
}, 70_000);
