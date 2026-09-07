import { spawn } from "node:child_process";
import { opendir, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { clipboardBlock, INPUT_LIMITS, type InputAttachment, type PermissionPolicy, type PermissionRequest } from "@agentkitai/agentrig-core";

/** Only explicit whitespace-delimited references, no glob/escape/shell interpretation. */
export function parseAttachments(text: string): { text: string; attachments: InputAttachment[] } {
  const attachments: InputAttachment[] = [];
  const prose = text.replace(/(^|\s)@@|(^|\s)@(?:"([^"\r\n]+)"|([^\s"@]+))/g, (whole, literal: string | undefined, prefix: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    if (literal !== undefined) return `${literal}@`;
    const path = quoted ?? bare!;
    if (path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("attachment path is unsupported");
    attachments.push({ kind: "file", path });
    if (attachments.length > INPUT_LIMITS.count) throw new Error("at most eight attachments");
    return prefix ?? "";
  });
  return { text: prose.trim(), attachments };
}

export async function completeAttachment(text: string, options: {
  cwd: string; sandbox?: string | undefined; permissions?: PermissionPolicy | undefined;
  ask(req: PermissionRequest, signal: AbortSignal): Promise<"allow" | "deny">;
}, signal: AbortSignal): Promise<{ text: string; hint: string }> {
  const match = /(^|\s)@([^\s"@]*)$/.exec(text);
  if (!match) return { text, hint: "" };
  if (options.sandbox !== undefined && options.sandbox !== "none") throw new Error("path completion is unavailable in an enforcing sandbox; enter an explicit reference");
  const token = match[2]!;
  if (token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) throw new Error("unsupported completion path");
  const requested = token.endsWith("/") || token.endsWith(sep) ? token : dirname(token);
  const directory = await realpath(resolve(options.cwd, requested || "."));
  signal.throwIfAborted();
  const req: PermissionRequest = { tool: "input_directory", class: "read", cwd: options.cwd, paths: [directory], input: { path: directory } };
  const decision = await options.permissions?.decide(req) ?? "ask";
  signal.throwIfAborted();
  if (decision !== "allow" && (decision !== "ask" || await options.ask(req,signal) !== "allow")) throw new Error("directory metadata read denied");
  signal.throwIfAborted();
  const entries: string[] = [], start = token.endsWith("/") || token.endsWith(sep) ? "" : basename(token);
  const handle = await opendir(directory); let count = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const entry = await handle.read(); if (!entry) break;
      if (++count > 256) throw new Error("completion directory exceeds 256 entries; narrow the path manually");
      if (!entry.name.startsWith(start) || /[\s"@\u0000-\u001f\u007f]/.test(entry.name)) continue;
      if (entry.isFile() || entry.isDirectory()) entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
    }
  } finally { await handle.close(); }
  entries.sort();
  const base = token.slice(0,token.length-start.length);
  const replacement = entries.length === 1 ? `@${base}${entries[0]}${entries[0]!.endsWith("/") ? "" : " "}` : `@${token}`;
  return { text: text.slice(0,text.length-token.length-1) + replacement, hint: entries.slice(0,32).join("  ") + (entries.length > 32 ? " …" : "") };
}

export function clipboardCommand(platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "pngpaste", args: ["-"] };
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoLogo","-NoProfile","-NonInteractive","-Sta","-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $image=[System.Windows.Forms.Clipboard]::GetImage(); if($null -eq $image){exit 2}; try { if(($image.Width * [long]$image.Height) -gt 16000000){exit 3}; $buffer=New-Object System.IO.MemoryStream; try { $image.Save($buffer,[System.Drawing.Imaging.ImageFormat]::Png); if($buffer.Length -gt 4194304){exit 3}; $bytes=$buffer.ToArray(); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length) } finally {$buffer.Dispose()} } finally {$image.Dispose()}" ] };
  if (platform === "linux" && env.WAYLAND_DISPLAY) return { command: "wl-paste", args: ["--type","image/png","--no-newline"] };
  if (platform === "linux" && /^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? "")) return { command: "xclip", args: ["-selection","clipboard","-t","image/png","-o"] };
  throw new Error("no supported local clipboard backend; attach an image file instead");
}

/** Fixed helper argv; captured-byte/deadline bounds are not a native decoder memory sandbox. */
export async function readClipboard(signal: AbortSignal, command = clipboardCommand()): Promise<InputAttachment> {
  signal.throwIfAborted();
  const data = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command.command,command.args,{ stdio: ["ignore","pipe","pipe"], windowsHide: true });
    const parts: Buffer[] = []; let size = 0, stderr = 0, failure: Error | undefined;
    const stop = (reason: string) => { failure ??= new Error(reason); child.kill("SIGKILL"); };
    const abort = () => stop("clipboard read cancelled");
    const timer = setTimeout(() => stop("clipboard read timed out"),2000);
    signal.addEventListener("abort",abort,{ once: true }); if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > INPUT_LIMITS.image) stop("clipboard exceeds 4 MiB"); else if (!failure) parts.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 4096) stop("clipboard helper diagnostics exceeded limit"); });
    child.on("error", () => { failure ??= new Error("clipboard helper unavailable"); });
    child.on("close", code => { clearTimeout(timer); signal.removeEventListener("abort",abort); if (failure) reject(failure); else if (code !== 0) reject(new Error("clipboard helper could not supply an image")); else resolve(Buffer.concat(parts,size)); });
  });
  signal.throwIfAborted(); const encoded = data.toString("base64"); clipboardBlock(encoded);
  return { kind: "clipboard", data: encoded };
}
