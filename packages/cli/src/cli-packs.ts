import type { Command } from "commander";
import { z } from "zod";
import { isStrictPackConfigSchema, loadRunConfig, type LoadRunConfigOptions } from "./config.js";

/** Trusted host-code API, not a sandbox or a project discovery mechanism. */
export interface CliPackCommand {
  name: string;
  summary: string;
  run(argv: string[], context: { config?: unknown; profile?: string; print(text: string): void }): void | Promise<void>;
}
export interface CliPack {
  name: string;
  summary: string;
  commands: CliPackCommand[];
  configSchema?: z.AnyZodObject;
}
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const Summary = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]+$/);
const ConfigSchema = z.custom<z.AnyZodObject>(isStrictPackConfigSchema, "configSchema must be a strict Zod object");
const Pack = z.object({ configSchema: ConfigSchema.optional(), name: Name, summary: Summary, commands: z.array(z.object({
  name: Name, summary: Summary,
  run: z.custom<CliPackCommand["run"]>(value => typeof value === "function"),
}).strict()).min(1).max(64) }).strict();

/** Validate the entire batch before mutating the tree. Builtins always win.
 * Pack handlers get literal operands after `--`, not Commander or root flags.
 */
export function registerCliPacks(program: Command, input: CliPack[], options: LoadRunConfigOptions = {}): void {
  const packs = z.array(Pack).max(32).parse(input);
  const names = new Set(["help", ...program.commands.flatMap(command => [command.name(), ...command.aliases()])]);
  for (const pack of packs) {
    if (pack.name === "ship" && pack.configSchema !== undefined) throw new Error("pack config namespace ship is reserved for compatibility");
    if (names.has(pack.name)) throw new Error(`reserved/duplicate CLI pack ${pack.name}`);
    names.add(pack.name);
    const commands = new Set(["help"]);
    for (const command of pack.commands) {
      if (commands.has(command.name)) throw new Error(`reserved/duplicate CLI command ${pack.name} ${command.name}`);
      commands.add(command.name);
    }
  }
  for (const pack of packs) {
    const namespace = program.command(pack.name).description(pack.summary);
    if (pack.configSchema !== undefined) namespace.option("--trust", "trust project configuration for this invocation");
    for (const command of pack.commands) {
      namespace.command(command.name).description(command.summary).argument("[args...]", "operands; use -- before option-like values")
        .action(async (argv: string[], _options: unknown, cmd: Command) => {
          const { profile } = cmd.optsWithGlobals() as { profile?: string };
          let config: unknown;
          if (pack.configSchema !== undefined) {
            await loadRunConfig(cmd, cmd.optsWithGlobals(), { ...options, packs,
              onPackConfig: namespaces => { config = namespaces[pack.name]; },
            });
          }
          await command.run([...argv], {
            ...(config === undefined ? {} : { config }), ...(profile === undefined ? {} : { profile }),
            print: text => { cmd.configureOutput().writeOut?.(`${text}\n`); } });
        });
    }
  }
}
