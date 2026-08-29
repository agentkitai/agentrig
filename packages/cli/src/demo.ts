/**
 * Writes a synthetic session — including the kind of loop the supervisor will need to
 * catch in M4 — then replays it. `pnpm demo`.
 */
import { SessionStore, contentHash } from "@harness/core";
import { renderEvent } from "./render.js";

const store = new SessionStore({ root: ".harness/sessions" });
const id = store.create();
const emit = (p: Parameters<SessionStore["append"]>[1]) => store.append(id, p);

await emit({ type: "session.start", task: "make the tests pass", cwd: process.cwd(), provider: "fake", model: "demo-1" });
for (let n = 1; n <= 3; n++) {
  await emit({ type: "turn.start", n });
  await emit({ type: "model.request", tokensIn: 1200 + n * 300 });
  const input = { cmd: "pnpm test" };
  await emit({ type: "tool.call", id: `t${n}`, name: "bash", input, inputHash: contentHash(input) });
  await emit({ type: "tool.result", id: `t${n}`, ok: false, display: "FAIL src/x.test.ts > expected 2 to be 3", durationMs: 800 });
  await emit({ type: "model.response", usage: { input: 1200 + n * 300, output: 90 }, stop: "tool_use" });
  await emit({ type: "turn.end", n });
}
await emit({
  type: "supervisor.signal",
  signal: { type: "loop", confidence: 0.9, evidence: ["same tool.call inputHash x3", "same failure substring x3"], window: [3, 20] },
});
await emit({ type: "supervisor.intervention", intervention: { type: "inject_guidance", message: "Three identical test runs failed the same way. Read the failing assertion before running again." } });
await emit({ type: "steer", source: "supervisor", message: "Three identical test runs failed the same way. Read the failing assertion before running again." });
await emit({ type: "session.end", reason: "aborted" });

console.log(`wrote session ${id}\n`);
for await (const e of store.read(id)) console.log(renderEvent(e));
