import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ExtensionManifestV1, resolveManifestNames, validateExtensionSurfaces } from "./manifests.js";
import { DEFAULT_HOOK_TIMEOUT_MS, HookPoint, type Hook } from "./hooks.js";
import { sanitizeLine } from "./tools/skills.js";
import type { AnyTool, ToolContext } from "./tool.js";
import { createExtensionOwner, extensionCallback, extensionDisabled, extensionHandler, ownExtension } from "./extension-runtime.js";
import { PermissionClass } from "./permission-types.js";
import { ShellOperationSchema } from "./shell-operation.js";

/**
 * What each synchronously typed tool descriptor must actually return.
 *
 * A JavaScript extension is not bound by the TypeScript signature, and the consumers here read the
 * value directly: `paths` returning the string `"/etc"` instead of `["/etc"]` iterates as eight
 * single-character paths, none of which a `cwdOnly` rule would recognise as the file being read.
 * Checking the shape at the boundary turns that into a disabled extension with a receipt.
 */
const DESCRIPTOR_SHAPES = {
  permission: (value: unknown) => { PermissionClass.parse(value); },
  paths: (value: unknown) => { z.array(z.string()).parse(value); },
  effects: (value: unknown) => { z.enum(["read-only", "workspace", "background"]).parse(value); },
  operation: (value: unknown) => { ShellOperationSchema.parse(value); },
} as const;

export interface ExtensionCommand {
  name: string;
  args?: string;
  summary: string;
  run(args: string, io: { print(text: string): void }): void | Promise<void>;
}
export interface ExtensionContext {
  readonly name: string;
  readonly session: { readonly cwd: string; readonly provider: { readonly id: string; readonly model: string } };
  readonly hooks: { on(point: HookPoint, handler: Hook["handler"], options?: { timeoutMs?: number }): void };
  registerTool(tool: AnyTool): void;
  registerCommand(command: ExtensionCommand): void;
  log(message: string): void;
}
export interface ExtensionReceipt {
  name: string;
  path: string;
  surfaces: { hooks: string[]; tools: string[]; commands: string[] };
}
export interface LoadedExtension extends ExtensionReceipt {
  hooks: Hook[];
  tools: AnyTool[];
  commands: ExtensionCommand[];
}
export interface FailedExtension {
  name: string;
  path: string;
  phase: "manifest" | "import" | "activate";
  message: string;
}
export interface ExtensionLoadResult { loaded: LoadedExtension[]; failed: FailedExtension[] }
export interface ExtensionCandidate { path: string; precedence: number }

/** Host-code warning, not an isolation claim or a permission grant. Emitted BEFORE import. */
export const EXTENSION_HOST_WARNING = "Trusted extension executes as ambient Node host code: it can access credentials, env, files and network, block or terminate this process. Manifests, permissions and timeouts do not sandbox it.";
const RESERVED_TOOLS = new Set(["bash", "bash_job", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch",
  "skill", "subagent", "update_plan", "read_output"]);
const Name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const CommandShape = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), args: z.string().max(128).optional(),
  summary: z.string().min(1).max(1024), run: z.custom<ExtensionCommand["run"]>(v => typeof v === "function") }).strict();

/** Project-only discovery. No symlinked .agentrig/container/module; caller must establish trust. */
export async function discoverExtensions(projectRoot: string): Promise<ExtensionCandidate[]> {
  const root = await realpath(projectRoot);
  const state = join(root, ".agentrig"); const directory = join(state, "extensions");
  try {
    if (!(await lstat(state)).isDirectory() || !(await lstat(directory)).isDirectory()) throw new Error("extension discovery refuses symlinked/non-directory containers");
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 128) throw new Error("extension directory exceeds 128 entries; none loaded");
    const modules = entries.filter(e => e.name.endsWith(".mjs"));
    if (modules.length > 32) throw new Error("extension directory exceeds 32 modules; none loaded");
    return modules.sort((a, b) => a.name.localeCompare(b.name, "en")).map(e => ({ path: join(directory, e.name), precedence: 1 }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Explicit trusted host integration. One activation per call/build, never per resumed session.
 * Timers can stop waiting on cooperative async code; they cannot interrupt synchronous Node. */
export async function loadExtensions(options: {
  candidates: ExtensionCandidate[];
  session: ExtensionContext["session"];
  builtinToolNames: ReadonlySet<string>;
  reservedCommandNames: ReadonlySet<string>;
  onNotice: (message: string) => void;
  timeoutMs?: number;
}): Promise<ExtensionLoadResult> {
  const timeoutMs = z.number().int().positive().max(10_000).parse(options.timeoutMs ?? 10_000);
  if (options.candidates.length > 32) throw new Error("extension candidate limit 32 exceeded; none imported");
  const result: ExtensionLoadResult = { loaded: [], failed: [] };
  const fail = (candidate: { name: string; path: string }, phase: FailedExtension["phase"], error: unknown) => {
    const message = sanitizeLine(String(error), 1024);
    result.failed.push({ name: candidate.name, path: candidate.path, phase, message });
    options.onNotice(`extension ${candidate.name} ${phase}: ${message}`);
  };
  const unique = new Map<string, ExtensionCandidate>();
  for (const candidate of options.candidates) {
    const path = resolve(candidate.path); const previous = unique.get(path);
    if (!previous || candidate.precedence < previous.precedence) unique.set(path, { ...candidate, path });
  }
  const candidates = [...unique.values()].map(c => ({ ...c, name: basename(c.path, ".mjs") }));
  const selected = resolveManifestNames(candidates, error => options.onNotice(error.message));
  const toolNames = new Set([...RESERVED_TOOLS, ...options.builtinToolNames].map(n => n.toLowerCase()));
  const commandNames = new Set([...options.reservedCommandNames].map(n => n.toLowerCase()));
  // All sidecars are checked before the first module executes. Invalid selected entries never
  // fall back to a lower-precedence definition; a declaration is not ambient-code confinement.
  const validated: Array<(typeof selected)[number] & { manifest: z.infer<typeof ExtensionManifestV1> }> = [];
  for (const candidate of selected) {
    try {
      Name.parse(candidate.name);
      if (!candidate.path.endsWith(".mjs")) throw new Error("extension must be a .mjs module");
      const sidecar = candidate.path.slice(0, -4) + ".json";
      const [moduleInfo, manifestInfo] = await Promise.all([lstat(candidate.path), lstat(sidecar)]);
      if (!moduleInfo.isFile() || moduleInfo.size > 1024 * 1024) throw new Error("extension module must be a regular non-symlink file at most 1 MiB");
      if (!manifestInfo.isFile() || manifestInfo.size > 16384) throw new Error("extension manifest must be a regular non-symlink file at most 16 KiB");
      const text = await readFile(sidecar, "utf8");
      if (Buffer.byteLength(text) > 16384) throw new Error("extension manifest exceeds 16 KiB");
      const manifest = ExtensionManifestV1.parse(JSON.parse(text));
      if (manifest.name !== candidate.name) throw new Error("extension manifest name must match module basename");
      validated.push({ ...candidate, manifest });
    } catch (error) { fail(candidate, "manifest", error); }
  }
  for (const candidate of validated) {
    const owner = createExtensionOwner(candidate, options.onNotice);
    let phase: FailedExtension["phase"] = "import";
    let sealed = false; let draftError: unknown; let draftFailed = false;
    const hooks: Hook[] = []; const tools: AnyTool[] = []; const commands: ExtensionCommand[] = [];
    const guard = (surface: "hooks" | "tools" | "commands", action: () => void) => {
      if (sealed) throw new Error("extension registration is sealed");
      try {
        validateExtensionSurfaces(candidate.manifest, [surface]);
        if (hooks.length + tools.length + commands.length >= 64) throw new Error("extension registration limit 64 exceeded");
        action();
      } catch (error) { draftFailed = true; draftError = error; throw error; }
    };
    const session = Object.freeze({ cwd: options.session.cwd,
      provider: Object.freeze({ id: options.session.provider.id, model: options.session.provider.model }) });
    const context: ExtensionContext = Object.freeze({ name: candidate.name, session,
      hooks: Object.freeze({ on(point: HookPoint, handler: Hook["handler"], opts?: { timeoutMs?: number }) {
        guard("hooks", () => {
          HookPoint.parse(point); if (typeof handler !== "function") throw new Error("hook handler must be a function");
          const limit = z.number().int().positive().parse(opts?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
          const registered: Hook = { point, handler: ctx => extensionDisabled(registered) ? { action: "continue" } : handler(ctx),
            id: `ext:${candidate.name}:${point}:${hooks.length}`, timeoutMs: Math.min(limit, DEFAULT_HOOK_TIMEOUT_MS) };
          hooks.push(ownExtension(Object.freeze(registered), owner));
        });
      } }),
      registerTool(tool: AnyTool) { guard("tools", () => {
        z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(tool.name);
        const name = tool.name.toLowerCase();
        if (name.startsWith("mcp__") || toolNames.has(name) || tools.some(t => t.name.toLowerCase() === name)) throw new Error(`reserved/duplicate tool ${name}`);
        z.string().min(1).max(8192).parse(tool.description);
        if (typeof tool.execute !== "function" || typeof tool.inputSchema?.parse !== "function") throw new Error("tool requires executable handler and input schema");
        if (typeof tool.permission !== "function") PermissionClass.parse(tool.permission);
        // Validate advertisement while still in the atomic draft, not after startup.
        const schema = tool.jsonSchema ?? zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" });
        z.record(z.unknown()).parse(schema); JSON.stringify(schema);
        const execute = tool.execute;
        // JS authors may return synchronously; the core lifecycle requires a real Promise.
        const registered: AnyTool = { ...tool,
          execute: (input: unknown, ctx: ToolContext) => extensionHandler(owner, "tool", `${tool.name}.execute`, () => execute.call(tool, input, ctx), ctx.signal) };
        for (const key of ["permission", "paths", "effects", "operation"] as const) {
          const callback = tool[key];
          if (typeof callback === "function") Object.assign(registered, {
            [key]: extensionCallback(owner, `${tool.name}.${key}`, callback.bind(tool), undefined, DESCRIPTOR_SHAPES[key]),
          });
        }
        if (tool.hasBackgroundWork !== undefined) registered.hasBackgroundWork = extensionCallback(owner,
          // an unusable probe leaves ownership uncertain, which is exactly what `true` means here
          `${tool.name}.hasBackgroundWork`, tool.hasBackgroundWork.bind(tool), () => true, (value) => { z.boolean().parse(value); });
        if (tool.resultSource !== undefined && typeof tool.resultSource !== "string") registered.resultSource = "file" in tool.resultSource ? {
          file: extensionCallback(owner, `${tool.name}.resultSource`, tool.resultSource.file.bind(tool.resultSource), undefined, (value) => { z.string().parse(value); }),
          // an unusable provenance probe means "treat the result as external", never as trusted
        } : { external: extensionCallback(owner, `${tool.name}.resultSource`, tool.resultSource.external.bind(tool.resultSource), () => true, (value) => { z.boolean().parse(value); }) };
        // Normal zod validation failures remain data, not a thrown extension fault.
        registered.inputSchema = new Proxy(tool.inputSchema, { get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "safeParse" || typeof value !== "function") return value;
          // a `safeParse` that reports success without `data` would admit an unvalidated input
          return extensionCallback(owner, `${tool.name}.inputSchema`, value.bind(target), undefined, (result) => {
            z.union([z.object({ success: z.literal(true) }).passthrough().refine((r) => "data" in r, "successful safeParse must carry data"),
              z.object({ success: z.literal(false), error: z.unknown() }).passthrough()]).parse(result);
          });
        } });
        tools.push(ownExtension(Object.freeze(registered), owner));
      }); },
      registerCommand(command: ExtensionCommand) { guard("commands", () => {
        const parsed = CommandShape.parse(command);
        if (commandNames.has(parsed.name) || commands.some(c => c.name === parsed.name)) throw new Error(`reserved/duplicate command ${parsed.name}`);
        commands.push(Object.freeze({ name: parsed.name, run: (args: string, io: Parameters<ExtensionCommand["run"]>[1]) => extensionHandler(owner, "command", parsed.name, () => parsed.run(args, io)), summary: sanitizeLine(parsed.summary, 200),
          ...(parsed.args === undefined ? {} : { args: sanitizeLine(parsed.args, 80) }) }));
      }); },
      log(message: string) { options.onNotice(`extension ${candidate.name}: ${sanitizeLine(String(message), 1024)}`); },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      options.onNotice(`extension ${candidate.name} (${sanitizeLine(candidate.path, 1024)}): ${EXTENSION_HOST_WARNING}`);
      await Promise.race([
        (async () => {
          const module: unknown = await import(pathToFileURL(candidate.path).href);
          if (sealed) return;
          const exports = module as { activate?: unknown; default?: unknown };
          const activate = exports.activate ?? exports.default;
          if (typeof activate !== "function") throw new Error("extension must export activate(ctx)");
          phase = "activate"; await activate(context);
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("extension import/activation timed out")), timeoutMs); }),
      ]);
      if (draftFailed) throw draftError;
      for (const tool of tools) toolNames.add(tool.name.toLowerCase());
      for (const command of commands) commandNames.add(command.name);
      result.loaded.push(ownExtension({ name: candidate.name, path: candidate.path, hooks, tools, commands,
        surfaces: { hooks: hooks.map(h => h.point), tools: tools.map(t => t.name), commands: commands.map(c => c.name) } }, owner));
    } catch (error) { fail(candidate, phase, error); }
    finally { sealed = true; if (timer !== undefined) clearTimeout(timer); }
  }
  return result;
}
