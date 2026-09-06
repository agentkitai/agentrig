import { OtelSink, OtlpExporter, otelEndpoint, type Session } from "@agentkitai/agentrig-core";

type Options = { otelEndpoint?: string; sandbox?: string; sandboxNetwork?: boolean };
let shared: { endpoint: string; sink: OtelSink; owners: number; closing: boolean } | undefined;
export function validateOtel(opts: Options): string | undefined {
  if (opts.otelEndpoint === undefined) return;
  const endpoint = otelEndpoint(opts.otelEndpoint);
  if (opts.sandbox !== undefined && opts.sandbox !== "none" && opts.sandboxNetwork !== true) {
    throw new Error("OTLP export requires explicit --sandbox-network in an enforcing sandbox; --allow net and YOLO do not enable it");
  }
  return endpoint;
}
export function acquireOtel(opts: Options, notice: (message: string) => void): {
  observe(session: Session): void; close(): Promise<void>;
} | undefined {
  const endpoint = validateOtel(opts); if (endpoint === undefined) return;
  const omitted = () => {
    try { notice("OTLP observations omitted for this build: the bounded exporter is unavailable; task execution continues."); } catch { /* safe notice */ }
    return { observe(_session: Session) {}, close: async () => {} };
  };
  // Availability is observational, not a reason to fail a task or start another exporter.
  if (shared !== undefined && (shared.closing || shared.endpoint !== endpoint || shared.owners >= 128)) return omitted();
  if (shared === undefined) shared = { endpoint, sink: new OtelSink(new OtlpExporter(endpoint)), owners: 0, closing: false };
  const owner = shared; owner.owners++;
  try { notice("OTLP enabled: minimized timing/status metadata leaves this process; no prompt, output or path content. HTTP endpoints are unencrypted."); } catch { /* notices cannot change the task */ }
  let closed = false;
  return { observe: session => { if (!closed) owner.sink.observe(session); }, close: async () => {
    if (closed) return; closed = true; owner.owners--;
    if (owner.owners !== 0) return;
    owner.closing = true;
    try {
      try { await owner.sink.close(); }
      catch { try { notice("OTLP shutdown failed; observations may be omitted. Task outcome is unchanged."); } catch { /* safe notice */ } }
      const c = owner.sink.counters;
      try { notice(`OTLP export: exported=${c.exported}, dropped=${c.dropped}, failed=${c.failed}, partial=${c.partial}, incomplete=${c.incomplete}. Delivery is not lossless.`); } catch { /* safe fixed metadata only */ }
    } finally { if (shared === owner) shared = undefined; }
  } };
}
