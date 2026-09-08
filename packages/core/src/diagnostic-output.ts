import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const TSC_DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
// Human-approved #254 amendment: metadata is finite, separate from diagnostic text.
// 4 MiB covers tens of thousands of ordinary paths; retention never grows past this cap.
export const TSC_METADATA_BYTES = 4 * 1024 * 1024;
// #264: measured ordinary listings are far below the cap, so retention starts at one line bound
// and doubles on demand. The cap, the byte accounting above it and overflow refusal are unchanged.
export const TSC_METADATA_INITIAL_BYTES = 8192;
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

  /** Bytes currently allocated for the retained coverage listing; zero before and after retention. */
  get metadataCapacity(): number { return this.metadata?.length ?? 0; }

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

  /**
   * Capacity for `bytes` more listing, doubling from a small buffer and copying what is retained.
   * The caller's byte accounting has already refused anything past `TSC_METADATA_BYTES`, so the
   * request never exceeds the cap; the loop still stops there rather than trusting that. Both
   * constants are powers of two, so the clamp cannot fire today — it is what keeps the doubling
   * from overshooting the cap if either one is ever changed to something else.
   */
  private reserve(bytes: number): Buffer {
    const needed = this.metadataLength + bytes;
    if (this.metadata !== undefined && this.metadata.length >= needed) return this.metadata;
    let size = this.metadata?.length ?? TSC_METADATA_INITIAL_BYTES;
    while (size < needed && size < TSC_METADATA_BYTES) size = Math.min(size * 2, TSC_METADATA_BYTES);
    const grown = Buffer.alloc(size);
    if (this.metadata !== undefined) this.metadata.copy(grown, 0, 0, this.metadataLength);
    this.metadata = grown;
    return grown;
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
      this.metadataLength += this.reserve(Buffer.byteLength(line) + 1).write(line + "\n", this.metadataLength, "utf8");
      return;
    }
    this.diagnosticBytes += bytes + (terminated ? 1 : 0);
    if (this.diagnosticBytes > this.maxDiagnosticBytes) throw new Error("checker output exceeded bound");
    this.text += raw + (terminated ? "\n" : "");
  }
}
