import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const TSC_DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
// Human-approved #254 amendment: metadata is finite, separate from diagnostic text.
// 4 MiB covers tens of thousands of ordinary paths; retention never grows past this cap.
export const TSC_METADATA_BYTES = 4 * 1024 * 1024;
export const TSC_LINE_BYTES = 8192;
type Stream = "stdout" | "stderr";

/** Internal trusted sink. Capture is synchronous; canonicalization is sequential and joined at close. */
export class TscDiagnosticOutput {
  private readonly decoders = { stdout: new TextDecoder("utf-8", { fatal: true }), stderr: new TextDecoder("utf-8", { fatal: true }) };
  private readonly pending: Record<Stream, string> = { stdout: "", stderr: "" };
  private diagnosticBytes = 0;
  private metadataBytes = 0;
  private metadata: Buffer | undefined;
  private metadataLength = 0;
  text = "";
  touchedFileListed = false;

  constructor(private readonly changedPath: string, private readonly maxDiagnosticBytes: number,
    private readonly signal: AbortSignal) {}

  write(chunk: Buffer, stream: Stream): void {
    this.signal.throwIfAborted();
    const text = this.pending[stream] + this.decoders[stream].decode(chunk, { stream: true });
    this.pending[stream] = "";
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.line(text.slice(start, end), stream, true);
      start = end + 1;
    }
    const tail = text.slice(start);
    if (Buffer.byteLength(tail) > TSC_LINE_BYTES) throw new Error("checker output line exceeded bound");
    this.pending[stream] = tail;
  }

  async end(): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      this.signal.throwIfAborted();
      // Fatal decoder flush refuses truncated UTF-8, rather than inventing a path character.
      const tail = this.pending[stream] + this.decoders[stream].decode();
      this.pending[stream] = "";
      if (tail !== "") this.line(tail, stream, false);
    }
    // No array of paths or growing promise queue: one canonicalization at a time from the bounded buffer.
    if (this.metadata !== undefined) {
      const paths = this.metadata.subarray(0, this.metadataLength);
      for (let start = 0, end = paths.indexOf(10); end !== -1; end = paths.indexOf(10, start)) {
        this.signal.throwIfAborted();
        const path = paths.subarray(start, end).toString("utf8");
        try {
          // Once coverage is witnessed, avoid repeated canonicalization but still reject unknown paths.
          if (this.touchedFileListed) await access(path);
          else if (await realpath(path) === this.changedPath) this.touchedFileListed = true;
        }
        catch { throw new Error("checker coverage path could not be verified"); }
        this.signal.throwIfAborted();
        start = end + 1;
      }
    }
    this.metadata = undefined;
  }

  private line(raw: string, stream: Stream, terminated: boolean): void {
    this.signal.throwIfAborted();
    const bytes = Buffer.byteLength(raw);
    if (bytes > TSC_LINE_BYTES) throw new Error("checker output line exceeded bound");
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Absolute diagnostic filenames must not be mistaken for listFiles metadata.
    if (stream === "stdout" && isAbsolute(line) && !TSC_DIAGNOSTIC_LINE.test(line)) {
      if (!terminated) throw new Error("checker coverage metadata ended without newline");
      this.metadataBytes += bytes + 1;
      if (this.metadataBytes > TSC_METADATA_BYTES) throw new Error("checker coverage metadata exceeded bound");
      this.metadata ??= Buffer.alloc(TSC_METADATA_BYTES);
      this.metadataLength += this.metadata.write(line + "\n", this.metadataLength, "utf8");
      return;
    }
    this.diagnosticBytes += bytes + (terminated ? 1 : 0);
    if (this.diagnosticBytes > this.maxDiagnosticBytes) throw new Error("checker output exceeded bound");
    this.text += raw + (terminated ? "\n" : "");
  }
}
