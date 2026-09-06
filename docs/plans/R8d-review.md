## Verdict: **APPROVE WITH FIXES**

No security or correctness defect confirmed. One load-bearing assumption is untested; the rest are low-severity nits.

### What I actually ran (reproductions)

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/cli/test/web.test.ts` | **15 passed**, 1.63 s |
| `pnpm exec vitest run --config vitest.web.config.ts` | **1 passed** (real Chromium), 2.38 s |
| `pnpm typecheck` | green, 4 packages |
| `git diff b3bb06a..9bd018c` | 17 files, +790/−8 |

Blocked by the sandbox (needed approval, non-interactive): `node -e`, `pnpm exec tsx -e`. I therefore could not build bespoke runtime probes, and combined with "no new files / no code mutation" every claim below marked *inference* is code-reading only. I did not run `pnpm build` or the full Docker suite; I did not re-verify the reported 2,908+2.

### Verified by reading ws@8.21.3 source (not by test)
- `websocket-server.js:356→372` — with no `verifyClient`, `handleUpgrade` reaches `completeUpgrade` and invokes `cb(ws, req)` synchronously. The exclusivity comment at `web.ts:54` is correct: no tick boundary lets a second upgrade race the `active` guard.
- `websocket.js:1138` `sendAfterClose` — post-close sends still fire `cb` once via `nextTick`, supporting the exactly-once callback ledger (`callbacks === writes` asserted at `web.test.ts:73`).

### Auth / Host / Origin / pre-ACP authority — sound
`web.ts:49-53` refuses before `handleUpgrade` on: closing, occupied slot, non-GET, non-`/acp`, Host≠authority, Origin≠`http://authority`, wrong length, non-base64url shape, and finally `timingSafeEqual`. `header()` (`web.ts:16-20`) returns `undefined` on duplicate *or* missing headers, so duplicate-Host and absent-Origin both refuse — reproduced, and `runs === 0` is asserted. `handleProtocols` selects only `agentrig-acp-v1`, never echoing the bearer. Assets are module constants with no interpolation; `frame-ancestors 'none'` blocks clickjacking of the Allow buttons. A cross-origin page can `<script src>` `/app.js`, but it carries no secret and no ambient credential exists. `--host` is zod-parsed at `web.ts:24` before `createServer`.

### Findings

**F1 — medium, test coverage of a load-bearing assumption. `packages/cli/src/web.ts:29,56`**
No test keeps an authenticated WebSocket alive longer than the 5 s `headersTimeout`/`requestTimeout`/`socket.setTimeout` deadlines. Survival depends on (a) `if (socket instanceof Socket) socket.setTimeout(0)` clearing the per-connection idle timer, and (b) Node exempting upgraded connections from the HTTP request-timeout checker. I believe both hold (the socket is a `net.Socket`; Node frees the parser from the connections list on upgrade, which is why ws servers don't die at the 300 s default). But 5 s is far shorter than a human typing a task, and *every* existing test — including the Chromium smoke — finishes in under ~1 s, so nothing would catch a regression here. **Unverified by reproduction.** Suggested fix: one test that connects, idles ~7 s, then completes an ACP round trip.

**F2 — low. `packages/cli/src/web.ts:69`** — `authority` is always `127.0.0.1:${port}`. With `--port 80` (root/CAP_NET_BIND_SERVICE) browsers omit the default port from `Host`, so every request and the upgrade refuse and the page is unusable. Inference.

**F3 — low. `packages/cli/src/web.ts:24`** — an invalid `--host` surfaces as a raw ZodError JSON dump through `index.ts:5`'s `error.message`, not a readable refusal. The contract's "refuses before binding" is met; only the message is poor. The test asserts `rejects.toThrow()` only.

**F4 — low, coverage. `packages/cli/src/web-bridge.ts:42`** — the `queue.length >= 1024` cap is never exercised. The byte cap is (two 600 KB frames, `web.test.ts:43`), but a small-message flood is exactly the case the frame-count cap exists for.

**F5 — low. `packages/cli/src/web-assets.ts:50`** — the page renders buttons only for `allow_once`/`reject_once`. Today `acp-server.ts:114` offers only those two, so it is safe; if another kind is ever added the page shows an approval card with no actionable button and the prompt hangs until cancel/disconnect. Prefer an explicit refusal over silent filtering.

**F6 — low, fragility. `packages/cli/src/web-bridge.ts:22`** — the outbound ledger patches the *public* `output.write`. Modern `Writable.prototype.end(chunk)` writes through an internal path and would bypass it. Nothing calls `output.end()` today (`acp-transport.ts` uses `write`/`destroy` only), so no live defect.

**F7 — informational. `packages/cli/src/web.ts:88`** — `startWeb`'s SIGINT/SIGTERM handlers override default termination, and `stopping ??=` makes a second Ctrl-C a no-op, so unsettling host code leaves SIGKILL as the only exit. This matches the documented contract and mirrors `startAcp`; noted, not a change request.

### Confirmed strengths
- Inbound cap proved with a genuinely non-consuming runtime (`web.test.ts:37-46`), not a mock.
- The reservation test (`web.test.ts:84-110`) is real: it holds the ws send callback and shows `reservedBytes === 131072` *after* peer receipt, then 0 after release — the "not high-water-mark promises" claim is earned.
- Slot exclusivity survives both a client-side overflow close and a throwing `run` (`web.test.ts:76-83`, `runs === 2`).
- Chromium smoke genuinely covers literal rendering: `#transcript img, script, a` count is 0, `webCanary` undefined, and all requests stay same-origin.
- `vitest.config.ts:9` includes only `*.test.ts`, so `web.browser.ts`/`web-fixture.ts` correctly stay out of `pnpm test`; the Chromium lane runs inside the existing Linux job, not as a fifth gate.

No files were modified. Scope limits preserved: no agents, no live providers, no remote services, no installs, no redirects, no code mutation.
