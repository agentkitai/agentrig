import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as timers from "node:timers/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMemoryStore, type IndexEntry } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

let root: string;
let store: FileMemoryStore;
let target: string;
let previous: string;
const entry: IndexEntry = { slug: "replacement", path: "concepts/replacement.md", type: "concept", status: "active", summary: "replacement" };
const failure = (code: string) => Object.assign(new Error(`rename refused: ${code}`), { code });
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
  vi.mocked(os.platform).mockReset().mockReturnValue("win32");
  const actualTimers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  vi.mocked(timers.setTimeout).mockReset().mockImplementation(actualTimers.setTimeout);
  root = await fs.mkdtemp(join(os.tmpdir(), "windows-memory-replace-"));
  store = new FileMemoryStore({ root: join(root, "wiki") });
  await store.init();
  target = join(store.root, "index.md");
  previous = await fs.readFile(target, "utf8");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function unchanged() {
  expect(await fs.readFile(target, "utf8")).toBe(previous);
  expect((await fs.readdir(store.root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  expect(vi.mocked(fs.rm).mock.calls.some(([path]) => path === target)).toBe(false);
}

describe("Windows memory atomic replacement", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s with the same complete temp under the existing lock", async code => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let temporary: string | undefined;
    let bytes: string | undefined;
    let attempts = 0;
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      expect(destination).toBe(target);
      expect(await fs.readFile(`${await fs.realpath(store.root)}.write.lock`, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      temporary ??= String(source);
      bytes ??= await fs.readFile(source, "utf8");
      expect(source).toBe(temporary);
      expect(await fs.readFile(source, "utf8")).toBe(bytes);
      expect(await fs.readFile(target, "utf8")).toBe(previous);
      if (attempts++ < 2) throw failure(code);
      return actual.rename(source, destination);
    });
    await store.writeIndex([entry]);
    expect(attempts).toBe(3);
    expect(await store.index()).toEqual([entry]);
    expect(vi.mocked(fs.rm).mock.calls.some(([path]) => path === target)).toBe(false);
  });

  it("exhausts a monotonic 250ms budget without a last attempt after the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(timers.setTimeout).mockImplementation(async ms => { now += Number(ms); });
    const error = failure("EPERM");
    vi.mocked(fs.rename).mockRejectedValue(error);
    await expect(store.writeIndex([entry])).rejects.toBe(error);
    expect(now).toBe(250);
    expect(fs.rename).toHaveBeenCalledTimes(13);
    expect(vi.mocked(timers.setTimeout).mock.calls.map(([ms]) => ms)).toEqual([...Array(12).fill(20), 10]);
    await unchanged();
  });

  it("does not retry when a delayed wakeup passes the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(timers.setTimeout).mockImplementation(async () => { now = 1000; });
    vi.mocked(fs.rename).mockRejectedValue(failure("EBUSY"));
    await expect(store.writeIndex([entry])).rejects.toThrow("EBUSY");
    expect(fs.rename).toHaveBeenCalledOnce();
    await unchanged();
  });

  it("aborts during the retry wait with no later commit", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(fs.rename).mockRejectedValueOnce(failure("EPERM"));
    const actualTimers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    vi.mocked(timers.setTimeout).mockImplementation((ms, value, options) => {
      expect(options?.signal).toBe(controller.signal);
      const result = actualTimers.setTimeout(ms, value, options);
      entered();
      return result;
    });
    const work = store.writeIndex([entry], { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow();
    await waiting;
    controller.abort();
    await rejected;
    await actualTimers.setTimeout(40);
    expect(fs.rename).toHaveBeenCalledOnce();
    await unchanged();
  });

  it("checks cancellation before a new attempt even if the wait resolves normally", async () => {
    const controller = new AbortController();
    vi.mocked(fs.rename).mockRejectedValueOnce(failure("EPERM"));
    vi.mocked(timers.setTimeout).mockImplementation(async () => { controller.abort(); });
    await expect(store.writeIndex([entry], { signal: controller.signal })).rejects.toThrow();
    expect(fs.rename).toHaveBeenCalledOnce();
    await unchanged();
  });

  it.each(["linux", "darwin"] as const)("does not retry access errors on %s", async platform => {
    vi.mocked(os.platform).mockReturnValue(platform);
    vi.mocked(fs.rename).mockRejectedValue(failure("EPERM"));
    await expect(store.writeIndex([entry])).rejects.toThrow("EPERM");
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(timers.setTimeout).not.toHaveBeenCalled();
    await unchanged();
  });

  it("does not retry other errors on Windows", async () => {
    vi.mocked(fs.rename).mockRejectedValue(failure("ENOSPC"));
    await expect(store.writeIndex([entry])).rejects.toThrow("ENOSPC");
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(timers.setTimeout).not.toHaveBeenCalled();
    await unchanged();
  });

  it("does not report an already committed rename as uncommitted if cancellation arrives afterward", async () => {
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      await actual.rename(source, destination);
      controller.abort();
    });
    await store.writeIndex([entry], { signal: controller.signal });
    expect(await store.index()).toEqual([entry]);
    expect(fs.rename).toHaveBeenCalledOnce();
  });
});
