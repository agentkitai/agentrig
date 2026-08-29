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

  it("reports a corrupt file with the path and a recovery hint", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(path, "{not json");
    await expect(new FileTokenStore(path).read()).rejects.toThrow(CorruptTokenFileError);
    await expect(new FileTokenStore(path).read()).rejects.toThrow(/delete it and re-run/);
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
