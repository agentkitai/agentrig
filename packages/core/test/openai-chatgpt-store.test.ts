import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorruptTokenFileError,
  EnvSeededTokenStore,
  FileTokenStore,
  type ChatGPTTokens,
} from "@agentkitai/agentrig-core";

let root: string;
let path: string;
const bundle: ChatGPTTokens = { accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-tokens-"));
  path = join(root, "nested", "auth.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  it("round-trips and creates the file 0600 in a 0700 directory", async () => {
    const store = new FileTokenStore(path);
    expect(await store.read()).toBeNull();
    await store.write(bundle);
    expect(await store.read()).toEqual(bundle);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "nested"))).mode & 0o777).toBe(0o700);
  });

  it("keeps 0600 when a permissive temp file already exists (no mode inheritance)", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    // a stale/planted tmp must never be reused; the random O_EXCL name sidesteps it
    await writeFile(`${path}.tmp`, "stale", { mode: 0o666 });
    await chmod(`${path}.tmp`, 0o666);
    const store = new FileTokenStore(path);
    await store.write(bundle);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(bundle);
  });

  it("never writes credentials through a planted symlink", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    const stolen = join(root, "STOLEN.json");
    await symlink(stolen, `${path}.tmp`);
    const store = new FileTokenStore(path);
    await store.write(bundle);
    // the symlink target must not have received the bundle
    await expect(readFile(stolen, "utf8")).rejects.toThrow();
    expect(await store.read()).toEqual(bundle);
  });

  it("leaves no temp file behind after a successful write", async () => {
    const store = new FileTokenStore(path);
    await store.write(bundle);
    const leftovers = (await readdir(join(root, "nested"))).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("tightens the ACL on Windows, where chmod only sets the read-only bit", async () => {
    const restricted: string[] = [];
    const store = new FileTokenStore(path, {
      platform: "win32",
      restrict: async (p) => void restricted.push(p),
    });
    await store.write(bundle);
    expect(restricted).toEqual([path]);
  });

  it("does not shell out on platforms where the mode is real", async () => {
    const restricted: string[] = [];
    const store = new FileTokenStore(path, { platform: "linux", restrict: async (p) => void restricted.push(p) });
    await store.write(bundle);
    expect(restricted).toEqual([]);
  });

  it("keeps the credential when the ACL call fails, and says what to run", async () => {
    const warnings: string[] = [];
    const store = new FileTokenStore(path, {
      platform: "win32",
      restrict: async () => {
        throw new Error("icacls not found");
      },
      warn: (m) => void warnings.push(m),
    });
    await store.write(bundle);

    // a credential that could not be locked down is still a credential the user needs
    expect(await store.read()).toEqual(bundle);
    expect(warnings.join("\n")).toContain("icacls");
    // ...and it says it once, not on every refresh
    await store.write(bundle);
    expect(warnings).toHaveLength(1);
  });

  it("reads a Codex auth.json copied into place, rather than calling it corrupt", async () => {
    const codexPath = join(root, "codex.json");
    // the device-code login is unusable (Cloudflare challenges every non-browser client), so
    // copying Codex's own credential here is the obvious move — and it used to fail with an
    // error that named neither the real problem nor the fix
    await writeFile(
      codexPath,
      JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt", account_id: "acc" } }),
    );
    expect(await new FileTokenStore(codexPath).read()).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      accountId: "acc",
    });
  });

  it("reports a corrupt file with the path and a recovery hint", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(path, "{not json");
    await expect(new FileTokenStore(path).read()).rejects.toThrow(CorruptTokenFileError);
    await expect(new FileTokenStore(path).read()).rejects.toThrow(/delete it and seed a credential again/);
  });
});

describe("EnvSeededTokenStore recovery", () => {
  it("falls back to the env seed when the file is corrupt, warning once", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(path, "{truncated");
    const warnings: string[] = [];
    const store = new EnvSeededTokenStore(
      new FileTokenStore(path),
      { AGENTRIG_OPENAI_CHATGPT_TOKEN: JSON.stringify({ tokens: { access_token: "seed", refresh_token: "r" } }) },
      "AGENTRIG_OPENAI_CHATGPT_TOKEN",
      (m) => warnings.push(m),
    );
    expect((await store.read())?.accessToken).toBe("seed");
    await store.read();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
  });

  it("still throws when the file is corrupt and there is no seed to fall back to", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(path, "{truncated");
    const store = new EnvSeededTokenStore(new FileTokenStore(path), {});
    await expect(store.read()).rejects.toThrow(CorruptTokenFileError);
  });
});
