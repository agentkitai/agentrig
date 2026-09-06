import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createOutputContract, parseOutputJson, OUTPUT_LIMITS, type OutputContract, type OutputMode } from "@agentkitai/agentrig-core";

/** Operator-selected file only, read once before provider/startup work. */
export async function readOutputContract(path: string, mode: OutputMode): Promise<OutputContract> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > OUTPUT_LIMITS.schemaBytes) throw new Error();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text: string;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
      const buffer = Buffer.alloc(OUTPUT_LIMITS.schemaBytes + 1); let length = 0;
      while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await file.stat(), current = await lstat(path);
      if (length > OUTPUT_LIMITS.schemaBytes || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.mtimeMs !== before.mtimeMs) throw new Error();
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
    return createOutputContract(parseOutputJson(text, OUTPUT_LIMITS.schemaBytes, OUTPUT_LIMITS.schemaDepth, OUTPUT_LIMITS.schemaNodes), mode);
  } catch { throw new Error("Output schema file refused: require stable regular UTF-8 JSON with unique keys and the documented bounded schema subset"); }
}
