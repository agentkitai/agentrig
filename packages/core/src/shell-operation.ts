import { z } from "zod";

const MAX_COMMAND_BYTES = 16_384;
const MAX_ARGS = 128;
const MAX_ARG_CHARS = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
const Arg = z.string().max(MAX_ARG_CHARS).refine(value => !CONTROL.test(value), "control characters are unsupported");
/** Explicit argv values, never a glob or a command-string pattern. */
export const CommandPrefixSchema = z.array(Arg.refine(value => value.length > 0, "prefix words must not be empty"))
  .min(1).max(MAX_ARGS).refine(argv => Buffer.byteLength(JSON.stringify(argv)) <= MAX_COMMAND_BYTES, "command prefix is too large");

export const ShellOperationSchema = z.discriminatedUnion("status", [
  z.object({ kind: z.literal("shell"), status: z.literal("parsed"), shell: z.string().min(1).max(4096),
    dialect: z.literal("posix-literal"), argv: z.array(Arg).min(1).max(MAX_ARGS)
      .refine(argv => argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) <= MAX_COMMAND_BYTES, "argv is too large"), background: z.boolean() }).strict(),
  z.object({ kind: z.literal("shell"), status: z.literal("unsupported"), shell: z.string().min(1).max(4096),
    reason: z.string().min(1).max(256), background: z.boolean() }).strict(),
]);
export type ShellOperation = z.infer<typeof ShellOperationSchema>;

const RESERVED = new Set(["!", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "select", "time", "coproc"]);

/** Recognize only literal argv in known POSIX shells. This never classifies a command as safe,
 * read-only, or attested. Unknown shell filenames are NOT assumed to speak this dialect. */
export function describeShellOperation(command: string, shell: string, background = false): ShellOperation {
  const unsupported = (reason: string): ShellOperation => ({ kind: "shell", status: "unsupported", shell, reason, background });
  const executable = shell.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase();
  if (!["sh", "bash", "dash"].includes(executable ?? "")) return unsupported("shell dialect is not supported for narrow command rules");
  if (command.length > MAX_COMMAND_BYTES || Buffer.byteLength(command) > MAX_COMMAND_BYTES) return unsupported("command exceeds 16 KiB");
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) return unsupported("command contains control characters or newlines");

  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const finish = (): boolean => {
    if (!started) return true;
    argv.push(word); word = ""; started = false;
    return argv.length <= MAX_ARGS;
  };
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else {
        if (char === "\t") return unsupported("quoted control characters are unsupported");
        if (quote === '"' && /[$`\\]/.test(char)) return unsupported("double-quoted expansion or escaping is unsupported");
        word += char;
      }
    } else if (char === " " || char === "\t") {
      if (!finish()) return unsupported("command exceeds 128 arguments");
    } else if (char === "'" || char === '"') {
      started = true; quote = char;
    } else {
      if (/[;&|<>(){}\[\]*?~$`\\#]/.test(char)) return unsupported("shell operators, expansion, globbing, comments or escaping are unsupported");
      started = true; word += char;
    }
    if (word.length > MAX_ARG_CHARS) return unsupported("command argument exceeds 4096 characters");
  }
  if (quote !== undefined) return unsupported("unclosed shell quote");
  if (!finish()) return unsupported("command exceeds 128 arguments");
  const first = argv[0];
  if (first === undefined || first === "") return unsupported("command has no literal executable");
  if (RESERVED.has(first) || /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(first)) return unsupported("shell control words or leading assignments are unsupported");
  return { kind: "shell", status: "parsed", shell, dialect: "posix-literal", argv, background };
}
