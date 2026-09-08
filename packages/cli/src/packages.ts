import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { z } from "zod";
import { ExtensionManifestV1, PackageManifestV1, parseSkill, resolveManifestNames, sanitizeLine } from "@agentkitai/agentrig-core";

export const PACKAGE_LIMITS = Object.freeze({ compressed: 20 * 1024 * 1024, bytes: 100 * 1024 * 1024, entries: 2000, path: 4096 });
type Limits = { compressed: number; bytes: number; entries: number; path: number };
type File = { path: string; bytes: Buffer };
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const FileRecord = z.object({ path: z.string().min(1).max(4096), size: z.number().int().nonnegative().max(PACKAGE_LIMITS.bytes), sha256: Digest }).strict();
const RecordSchema = z.object({ schema: z.literal(1), name: z.string(), version: z.string(), source: z.string().max(4096),
  installedAt: z.string(), digest: Digest, files: z.array(FileRecord).max(PACKAGE_LIMITS.entries) }).strict();
type InstallRecord = z.infer<typeof RecordSchema>;
const RECORD = ".agentrig-package.json";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const packageDirectoryName = (name: string) => `pkg-${hash(name)}`;
const digest = (files: InstallRecord["files"]) => hash(files.map(f => `${f.path}\0${f.size}\0${f.sha256}`).join("\n"));
const selected = (path: string) => path === "package.json" || /^(extensions|skills|prompts)\//.test(path) || /^(README|LICENSE)[^/]*$/i.test(path);
const container = (path: string) => /^(extensions|skills|prompts)$/.test(path);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function limits(input?: Partial<Limits>): Limits {
  const result = { ...PACKAGE_LIMITS, ...input };
  for (const key of Object.keys(PACKAGE_LIMITS) as Array<keyof Limits>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > PACKAGE_LIMITS[key]) throw new Error(`invalid package limit ${key}`);
  }
  return result;
}
/** Final logical paths after the maintained parser's PAX/GNU overrides. */
function portablePath(input: string, maximum: number): string {
  if (Buffer.byteLength(input) > maximum || input !== input.normalize("NFC") || /[\u0000-\u001f\u007f-\u009f\\:]/.test(input)) throw new Error(`unsafe package path ${JSON.stringify(input)}`);
  const parts = input.split("/");
  if (parts.length > 64 || parts.some(part => !part || part === "." || part === ".." || /[<>"|?*]|[. ]$/.test(part)
    || Buffer.byteLength(part) > 240 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`unsafe package path ${JSON.stringify(input)}`);
  return input;
}
function pathTracker(maximum: number) {
  const nodes = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
  return (path: string, directory: boolean) => {
    portablePath(path, maximum);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/"); const key = part.toLowerCase();
      const dir = i < parts.length || directory; const explicit = i === parts.length;
      const previous = nodes.get(key);
      if (previous !== undefined && (previous.path !== part || previous.directory !== dir || (explicit && previous.explicit))) throw new Error(`duplicate/conflicting package path ${path}`);
      nodes.set(key, { path: part, directory: dir, explicit: explicit || previous?.explicit === true });
    }
  };
}
async function readBounded(path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > maximum) throw new Error(`package file is linked, non-regular or oversized: ${path}`);
  const chunks: Buffer[] = []; let size = 0;
  const stream = createReadStream(path, { ...(signal === undefined ? {} : { signal }) });
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > maximum) { stream.destroy(); throw new Error(`package byte limit exceeded: ${path}`); }
    chunks.push(chunk as Buffer);
  }
  const after = await lstat(path);
  if (before.ino !== after.ino || before.dev !== after.dev || !after.isFile() || after.isSymbolicLink() || after.nlink > 1 || after.size !== size) throw new Error(`package file changed while reading: ${path}`);
  return Buffer.concat(chunks);
}
class AggregateLimit extends Error {}
async function directoryFiles(root: string, cap: Limits, signal?: AbortSignal, installed = false,
  remaining?: { bytes: number; entries: number }): Promise<{ files: File[]; ignored: string[] }> {
  const files: File[] = []; const ignored: string[] = []; const track = pathTracker(cap.path);
  let count = 0; let bytes = 0;
  async function walk(relative: string) {
    signal?.throwIfAborted();
    const names = await readdir(join(root, relative));
    if (names.length + count > cap.entries + (installed ? 1 : 0)) throw new Error("package entry limit exceeded");
    for (const name of names.sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, path));
      if (!stat.isDirectory() && !stat.isFile() || stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`package link/device/non-regular entry refused: ${path}`);
      if (installed && path === RECORD) continue;
      if (remaining !== undefined && --remaining.entries < 0) throw new AggregateLimit("aggregate package discovery entry limit exceeded; none loaded");
      if (++count > cap.entries) throw new Error("package entry limit exceeded");
      track(path, stat.isDirectory());
      if (container(path) && !stat.isDirectory()) throw new Error(`package surface container must be a directory: ${path}`);
      if (!selected(path) && !container(path)) { ignored.push(path); continue; }
      if (stat.isDirectory()) await walk(path);
      else {
        if (remaining !== undefined) {
          remaining.bytes -= stat.size;
          if (remaining.bytes < 0) throw new AggregateLimit("aggregate package discovery byte limit exceeded; none loaded");
        }
        const data = await readBounded(join(root, path), cap.bytes - bytes, signal); bytes += data.length;
        files.push({ path, bytes: data });
      }
    }
  }
  await walk(""); return { files, ignored };
}
export async function readPackageArchive(bytes: Buffer, options: { signal?: AbortSignal; limits?: Partial<Limits> } = {}): Promise<{ files: File[]; ignored: string[] }> {
  const cap = limits(options.limits); options.signal?.throwIfAborted();
  if (bytes.length > cap.compressed) throw new Error("compressed package byte limit exceeded");
  const parser = extract(); const inflater = createGunzip(); const track = pathTracker(cap.path);
  const files: File[] = []; const ignored: string[] = []; let expanded = 0; let count = 0; let rootSeen = false;
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    expanded += chunk.length;
    callback(expanded > cap.bytes ? new Error("expanded package byte limit exceeded") : null, chunk);
  } });
  // tar-stream uses streamx's Node-compatible writable; its TypeScript class is deliberately
  // narrower than Node's WritableStream interface. No filesystem extraction is delegated to it.
  const pumping = pipeline(Readable.from([bytes]), inflater, bounded, parser as unknown as NodeJS.WritableStream,
    options.signal === undefined ? {} : { signal: options.signal });
  void pumping.catch(() => {});
  try {
    for await (const entry of parser) {
      options.signal?.throwIfAborted();
      const header = entry.header;
      const paxSize = (header.pax as Record<string, unknown> | undefined)?.size;
      if (paxSize !== undefined && (typeof paxSize !== "string" || !/^(0|[1-9][0-9]*)$/.test(paxSize))) throw new Error("invalid PAX package size");
      if (++count > cap.entries) throw new Error("package entry limit exceeded");
      if (header.type !== "file" && header.type !== "directory") throw new Error(`package link/device/type refused: ${header.name}`);
      if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > cap.bytes || (header.type === "directory" && header.size !== 0)) throw new Error(`invalid package size: ${header.name}`);
      const full = header.type === "directory" && header.name.endsWith("/") ? header.name.slice(0, -1) : header.name;
      portablePath(full, cap.path);
      if (full === "package" && header.type === "directory" && !rootSeen) { rootSeen = true; entry.resume(); continue; }
      if (!full.startsWith("package/")) throw new Error(`package archive entry must be beneath package/: ${full}`);
      const path = full.slice(8); track(path, header.type === "directory");
      if (container(path) && header.type !== "directory") throw new Error(`package surface container must be a directory: ${path}`);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of entry) {
        size += (chunk as Buffer).length;
        if (size > header.size || size > cap.bytes) throw new Error(`package entry byte limit exceeded: ${path}`);
        if (selected(path)) chunks.push(Buffer.from(chunk as Buffer));
      }
      if (size !== header.size) throw new Error(`truncated package entry: ${path}`);
      if (header.type === "file") {
        if (selected(path)) files.push({ path, bytes: Buffer.concat(chunks) }); else ignored.push(path);
      }
    }
    await pumping; return { files, ignored };
  } finally { parser.destroy(); inflater.destroy(); bounded.destroy(); await pumping.catch(() => {}); }
}

function validate(files: File[]) {
  const manifestFile = files.find(file => file.path === "package.json");
  if (manifestFile === undefined || manifestFile.bytes.length > 64 * 1024) throw new Error("package.json is required and must be at most 64 KiB");
  const manifest = PackageManifestV1.parse(JSON.parse(manifestFile.bytes.toString("utf8")));
  const extensions: Array<{ name: string; path: string; precedence: number }> = [];
  const skills: Array<{ name: string; path: string; precedence: number }> = [];
  const skillRoots = new Set(files.filter(file => file.path.startsWith("skills/")).map(file => file.path.split("/")[1]));
  let skillBytes = 0;
  if (skillRoots.size > 1024) throw new Error("package skill root exceeds loader entry limit");
  for (const file of files) {
    const nestedSkill = /^skills\/[^/]+\/(skill\.md)$/i.exec(file.path);
    if (nestedSkill !== null && nestedSkill[1] !== "SKILL.md") {
      throw new Error(`nested package skill filename must be exactly SKILL.md: ${file.path}`);
    }
    if (/^extensions\/[^/]+\.mjs$/.test(file.path)) {
      const sidecar = files.find(other => other.path === file.path.slice(0, -4) + ".json");
      if (file.bytes.length > 1024 * 1024 || sidecar === undefined || sidecar.bytes.length > 16384) throw new Error(`extension module/sidecar missing or oversized: ${file.path}`);
      const declared = ExtensionManifestV1.parse(JSON.parse(sidecar.bytes.toString("utf8")));
      if (`extensions/${declared.name}.mjs` !== file.path) throw new Error(`extension manifest name mismatch: ${file.path}`);
      extensions.push({ name: declared.name, path: file.path, precedence: 0 });
    }
    if (/^skills\/(?:[^/]+\.md|[^/]+\/SKILL\.md)$/i.test(file.path)) {
      if (file.bytes.length > 256 * 1024) throw new Error(`oversized package skill: ${file.path}`);
      skillBytes += file.bytes.length;
      if (skillBytes > 8 * 1024 * 1024) throw new Error("package skill root exceeds loader byte limit");
      const skill = parseSkill(file.bytes.toString("utf8"), file.path);
      skills.push({ name: skill.name, path: file.path, precedence: 0 });
    }
  }
  if (extensions.length > 32 || skills.length > 100) throw new Error("package surface count limit exceeded");
  const invalid = (error: Error) => { throw error; };
  resolveManifestNames(extensions, invalid); resolveManifestNames(skills, invalid);
  return { manifest, extensions: extensions.map(value => value.path), skills: skills.map(value => value.path),
    prompts: files.filter(file => file.path.startsWith("prompts/")).map(file => file.path) };
}
async function packagesRoot(projectRoot: string, create: boolean): Promise<string | undefined> {
  const canonical = await realpath(projectRoot).catch(error => { if (!create && missing(error)) return undefined; throw error; });
  if (canonical === undefined) return undefined;
  let directory = canonical;
  for (const part of [".agentrig", "packages"]) {
    directory = join(directory, part);
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await lstat(directory).catch(error => { if (missing(error)) return undefined; throw error; });
    if (stat === undefined) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`package container must be a real directory: ${directory}`);
  }
  return directory;
}
async function installLock(root: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const path = join(root, ".install-lock"); const started = Date.now();
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 10_000) throw new Error("package install lock busy; stop installers before manual stale-lock recovery");
      await delay(25, undefined, signal === undefined ? {} : { signal });
    }
  }
  const owned = await lstat(path);
  return async () => {
    const current = await lstat(path);
    if (current.ino !== owned.ino || current.dev !== owned.dev || !current.isDirectory() || current.isSymbolicLink()) throw new Error("package install lock was replaced; refusing cleanup");
    await rmdir(path);
  };
}
export async function addPackage(options: { projectRoot: string; source: string; signal?: AbortSignal; limits?: Partial<Limits> }) {
  const cap = limits(options.limits); const source = resolve(options.source); options.signal?.throwIfAborted();
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error("package source cannot be a symlink");
  const bundle = stat.isDirectory() ? await directoryFiles(source, cap, options.signal)
    : /\.(tgz|tar\.gz)$/i.test(source) ? await readPackageArchive(await readBounded(source, cap.compressed, options.signal), options)
    : (() => { throw new Error("package source must be a local directory, .tgz or .tar.gz path"); })();
  const validated = validate(bundle.files);
  bundle.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const listed = bundle.files.map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes) }));
  const record: InstallRecord = { schema: 1, name: validated.manifest.name, version: validated.manifest.version,
    source, installedAt: new Date().toISOString(), digest: digest(listed), files: listed };
  const root = (await packagesRoot(options.projectRoot, true))!; const release = await installLock(root, options.signal);
  let staging: string | undefined;
  try {
    const destination = join(root, packageDirectoryName(record.name));
    if (await lstat(destination).then(() => true, error => { if (missing(error)) return false; throw error; })) throw new Error(`package ${record.name} destination already exists; create-only install preserves it`);
    staging = await mkdtemp(join(root, ".staging-"));
    for (const file of bundle.files) {
      options.signal?.throwIfAborted();
      const path = join(staging, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(staging, RECORD), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    options.signal?.throwIfAborted();
    if (await lstat(destination).then(() => true, error => { if (missing(error)) return false; throw error; })) throw new Error("package destination appeared during staging; refusing overwrite");
    await rename(staging, destination); staging = undefined;
    return { ...record, destination, ignored: bundle.ignored, prompts: validated.prompts };
  } finally { try { if (staging !== undefined) await rm(staging, { recursive: true, force: true }); } finally { await release(); } }
}

/** `digest` is the record's content digest, exposed only after this inspection recomputed and
 * matched it: an identity built from name/version/size alone cannot tell two same-length bodies
 * apart, so anything pinning a bundle byte for byte needs the digest itself. */
export interface InstalledPackage { name: string; version: string; digest: string; directory: string; extensions: string[]; skills: string[]; prompts: string[]; bytes: number; files: number }
export async function inspectPackages(projectRoot: string, signal?: AbortSignal): Promise<{ packages: InstalledPackage[]; errors: string[] }> {
  const root = await packagesRoot(projectRoot, false);
  if (root === undefined) return { packages: [], errors: [] };
  const names = (await readdir(root)).filter(name => name !== ".install-lock" && !name.startsWith(".staging-")).sort();
  if (names.length > 32) return { packages: [], errors: ["package discovery exceeds 32 entries; none loaded"] };
  const packages: InstalledPackage[] = []; const errors: string[] = [];
  const remaining = { bytes: PACKAGE_LIMITS.bytes, entries: PACKAGE_LIMITS.entries };
  for (const name of names) {
    try {
      signal?.throwIfAborted();
      if (!/^pkg-[a-f0-9]{64}$/.test(name)) throw new Error(`unrecognized installed package directory ${name}`);
      const directory = join(root, name); const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("installed package must be a real directory");
      const record = RecordSchema.parse(JSON.parse((await readBounded(join(directory, RECORD), 1024 * 1024, signal)).toString("utf8")));
      const bundle = await directoryFiles(directory, PACKAGE_LIMITS, signal, true, remaining);
      if (bundle.ignored.length > 0) throw new Error("installed package has unrecorded/unsupported entries");
      const validated = validate(bundle.files);
      const listed = bundle.files.sort((a, b) => a.path < b.path ? -1 : 1).map(file => ({ path: file.path, size: file.bytes.length, sha256: hash(file.bytes) }));
      if (record.name !== validated.manifest.name || record.version !== validated.manifest.version || name !== packageDirectoryName(record.name)
        || JSON.stringify(record.files) !== JSON.stringify(listed) || record.digest !== digest(listed)) throw new Error("package integrity mismatch; preserve/remove it explicitly before reinstalling");
      packages.push({ name: record.name, version: record.version, digest: record.digest, directory, extensions: validated.extensions.map(path => join(directory, path)),
        skills: validated.skills.length === 0 ? [] : [join(directory, "skills")], prompts: validated.prompts, bytes: listed.reduce((sum, file) => sum + file.size, 0), files: listed.length });
    } catch (error) {
      if (error instanceof AggregateLimit) return { packages: [], errors: [...errors, error.message] };
      signal?.throwIfAborted(); errors.push(`${name}: ${sanitizeLine(String(error), 1024)}`);
    }
  }
  return { packages, errors };
}
