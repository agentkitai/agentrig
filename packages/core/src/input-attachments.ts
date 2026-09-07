import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ContentBlock } from "./messages.js";
import type { AnyTool } from "./tool.js";
import { ADVISORY_CONTEXT } from "./context-principals.js";

export const INPUT_LIMITS = { count: 8, text: 65536, textTotal: 262144, image: 4194304, imageTotal: 8388608, pixels: 16000000 } as const;
const pathSchema = z.string().min(1).max(4096).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
export const InputAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: pathSchema }).strict(),
  z.object({ kind: z.literal("clipboard"), data: z.string().max(5592408) }).strict(),
]);
export const InputAttachmentsSchema = z.array(InputAttachmentSchema).max(INPUT_LIMITS.count);
export type InputAttachment = z.infer<typeof InputAttachmentSchema>;

/** Bounded container-header checks, not a complete image decoder or authenticity proof. */
export function imageHeader(b: Buffer): { mediaType: string; width: number; height: number } | undefined {
  let mediaType = "", width = 0, height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString("ascii",12,16) === "IHDR") {
    mediaType = "image/png"; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("ascii",0,6))) {
    mediaType = "image/gif"; width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 30 && b.toString("ascii",0,4) === "RIFF" && b.toString("ascii",8,12) === "WEBP") {
    mediaType = "image/webp";
    const chunk = b.toString("ascii",12,16);
    if (chunk === "VP8X") { width = 1 + b.readUIntLE(24,3); height = 1 + b.readUIntLE(27,3); }
    else if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else if (chunk === "VP8L" && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
    mediaType = "image/jpeg";
    for (let offset = 2, segments = 0; offset + 4 <= b.length && segments < 4096; segments++) {
      if (b[offset++] !== 255) break;
      while (offset < b.length && b[offset] === 255) offset++;
      const marker = b[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > b.length) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = b.readUInt16BE(offset);
      if (size < 2 || offset + size > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 8) {
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  }
  if (!mediaType) return undefined;
  if (!width || !height || width * height > INPUT_LIMITS.pixels) throw new Error("unsupported or oversized image dimensions");
  return { mediaType, width, height };
}

export function clipboardBlock(data: string): ContentBlock {
  if (data.length > 5592408 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("invalid clipboard encoding");
  const bytes = Buffer.from(data,"base64");
  if (bytes.toString("base64") !== data) throw new Error("noncanonical clipboard encoding");
  if (bytes.length > INPUT_LIMITS.image || imageHeader(bytes)?.mediaType !== "image/png") throw new Error("clipboard must contain a bounded PNG image");
  return { type: "image", mediaType: "image/png", data, trust: "user", context: ADVISORY_CONTEXT };
}

/** Private per-invocation tool: no model registration or path supplied by tool-name hints. */
export function attachmentReader(receive: (block: ContentBlock, bytes: number) => void): AnyTool {
  return {
    name: "input_file", description: "Read one explicitly attached file", permission: "read", effects: "read-only", sandbox: "compatible",
    inputSchema: z.object({ path: pathSchema }).strict(), paths: input => [input.path], resultSource: { file: input => input.path },
    async execute(input, ctx) {
      ctx.signal.throwIfAborted();
      const path = resolve(await realpath(ctx.cwd), input.path);
      const stat = await lstat(path);
      if (!stat.isFile() || await realpath(path) !== path) throw new Error("attachment must be a regular non-aliased file");
      if (stat.size > INPUT_LIMITS.image) throw new Error("attachment exceeds 4 MiB");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error("attachment changed while opening");
        const bytes = Buffer.alloc(Math.min(INPUT_LIMITS.image + 1, before.size + 1)); let size = 0;
        while (size < bytes.length) { ctx.signal.throwIfAborted(); const read = await file.read(bytes,size,bytes.length-size,size); if (!read.bytesRead) break; size += read.bytesRead; }
        const after = await file.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("attachment changed during read");
        const body = bytes.subarray(0,size); const image = imageHeader(body);
        if (image) receive({ type: "image", mediaType: image.mediaType, data: body.toString("base64") },size);
        else {
          if (/\.(png|jpe?g|gif|webp)$/i.test(path)) throw new Error("invalid image header");
          if (size > INPUT_LIMITS.text) throw new Error("text attachment exceeds 64 KiB");
          const text = new TextDecoder("utf-8",{ fatal: true }).decode(body);
          if (text.includes("\0")) throw new Error("binary attachment is unsupported");
          receive({ type: "text", text },size);
        }
        return { output: { bytes: size }, display: `Attached ${input.path} (${size} bytes)` };
      } finally { await file.close(); }
    },
  };
}
