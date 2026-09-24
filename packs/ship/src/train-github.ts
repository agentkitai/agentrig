import { appendFile } from "node:fs/promises";
import type { TrainCommand } from "@agentkitai/agentrig-train";

const wrapped = new WeakSet<TrainCommand>();

/** Host transport only: never retries child ship or interprets CI conclusions. */
export function trainGithubCommand(
  command: TrainCommand,
  { ceilingMs = 300_000, now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) } = {},
): TrainCommand {
  if (wrapped.has(command)) return command;
  const decorated: TrainCommand = async request => {
    if (request.executable !== "gh") return command(request);
    const started = now();
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const result = await command(request);
      const text = `${result.stderr}\n${result.stdout}`;
      const limited = /\bHTTP(?:\/\d+(?:\.\d+)?)?\s+429\b/iu.test(text) || /(?:rate limit|secondary rate|abuse detection)/iu.test(text);
      if (result.code === 0 || !limited) return result;
      let delay: number | undefined;
      const retry = text.match(/^\s*retry-after:\s*(.+)$/imu)?.[1]?.trim();
      if (retry !== undefined) {
        const value = /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
        if (Number.isFinite(value)) delay = Math.max(1000, value);
      }
      const reset = text.match(/^\s*x-ratelimit-reset:\s*(\d+)\s*$/imu)?.[1];
      if (delay === undefined && reset !== undefined) delay = Math.max(1000, Number(reset) * 1000 - now());
      if (delay === undefined) {
        // Probe once per failed attempt, without recursively retrying the probe itself.
        const probe = await command({ ...request, argv: ["api", "rate_limit"] });
        if (probe.code === 0) {
          try {
            const data = JSON.parse(probe.stdout) as { resources?: Record<string, { remaining?: unknown; reset?: unknown }> };
            // The host's PR lookup uses GraphQL; run-list uses REST core.
            // Other quotas must neither extend the wait nor cause premature retries.
            const resource = request.argv[0] === "pr" && request.argv[1] === "view" ? "graphql"
              : request.argv[0] === "run" && request.argv[1] === "list" ? "core" : undefined;
            const quota = resource === undefined ? undefined : data.resources?.[resource];
            if (quota?.remaining === 0 && typeof quota.reset === "number" && Number.isFinite(quota.reset))
              delay = Math.max(1000, quota.reset * 1000 - now());
          } catch { /* Missing/malformed metadata uses conservative secondary-limit backoff. */ }
        }
      }
      delay ??= Math.min(60_000 * 2 ** attempt, 300_000);
      if (Math.max(waited, now() - started) + delay > ceilingMs) {
        throw new Error(`GitHub rate limit exhausted: ${request.argv.slice(0, 2).join(" ")} exceeded ${ceilingMs}ms retry wait ceiling; see row log`);
      }
      await appendFile(request.log, JSON.stringify({ type: "train.github.rate_limit", attempt: attempt + 1, waitMs: delay, ceilingMs }) + "\n");
      await sleep(delay);
      waited += delay;
    }
  };
  wrapped.add(decorated);
  return decorated;
}
