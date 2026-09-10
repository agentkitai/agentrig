import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { buildProgram } from "../src/program.ts";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

it("reads the installed package's version rather than a baked-in literal or cwd manifest", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentrig-version-package-")));
  try {
    const installed = join(cwd, "installed");
    await mkdir(installed);
    await cp(fileURLToPath(new URL("../dist", import.meta.url)), join(installed, "dist"), { recursive: true });
    await mkdir(join(installed, "node_modules"));
    // Link the external startup dependency's canonical directory, not node_modules:
    // pnpm's relative links can resolve against the relocated junction on Windows.
    const yoga = await realpath(fileURLToPath(new URL("../node_modules/yoga-layout", import.meta.url)));
    await symlink(yoga, join(installed, "node_modules/yoga-layout"), "junction");
    await writeFile(join(installed, "package.json"), JSON.stringify({ ...manifest, version: "9.8.7-version-test.1" }));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ version: "1.2.3-wrong-cwd" }));
    const result = spawnSync(process.execPath, [join(installed, "dist/index.js"), "--version"], {
      cwd, encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, NO_COLOR: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("9.8.7-version-test.1\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);

it.each(["--version", "-V"])("%s prints the package version without dispatching an action", async (flag) => {
  const run = vi.fn();
  const tui = vi.fn();
  const output = vi.fn();
  const program = buildProgram({ run, tui }).exitOverride().configureOutput({ writeOut: output, writeErr: () => {} });
  await expect(program.parseAsync([flag], { from: "user" })).rejects.toMatchObject({ code: "commander.version", exitCode: 0 });
  expect(output).toHaveBeenCalledExactlyOnceWith(`${manifest.version}\n`);
  expect(run).not.toHaveBeenCalled();
  expect(tui).not.toHaveBeenCalled();
});

it("the built CLI exits cleanly offline without creating session files; help still works", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentrig-version-")));
  try {
    const guard = join(cwd, "offline.cjs");
    await writeFile(guard, `const deny = () => { throw new Error('network forbidden'); };
      // Yoga loads embedded WASM through fetch(data:), which does not use the network.
      const fetch = globalThis.fetch;
      globalThis.fetch = (input, ...args) => String(input).startsWith('data:') ? fetch(input, ...args) : deny();
      require('node:http').request = deny; require('node:http').get = deny;
      require('node:https').request = deny; require('node:https').get = deny;
      require('node:net').Socket.prototype.connect = deny;
      require('node:tls').connect = deny;
    `);
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    for (const flag of ["--version", "-V", "--help"]) {
      const result = spawnSync(process.execPath, ["--require", guard, entry, flag], {
        cwd, encoding: "utf8", timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, NO_COLOR: "1" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      if (flag !== "--help") expect(result.stdout).toBe(`${manifest.version}\n`);
      else {
        expect(result.stdout).toContain("Usage: agentrig");
        expect(result.stdout).toContain("--version");
        expect(result.stdout).toContain("sessions");
      }
    }
    expect(await readdir(cwd)).toEqual(["offline.cjs"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
