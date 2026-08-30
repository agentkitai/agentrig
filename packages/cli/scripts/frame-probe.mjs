/**
 * Renders the real TUI component in a real terminal and records what reaches stdout, so a freeze
 * that no fake TTY reproduces can be measured where it actually happens.
 *
 * Usage, from the repo root, after `pnpm build`:
 *
 *   node packages/cli/scripts/frame-probe.mjs
 *
 * Paste into it, wait a moment, then press ctrl-c. Do NOT press enter: there is no agent behind
 * this, and submitting would only measure that. The log lands in /tmp/agentrig-frame-probe.log.
 *
 * Everything here is traced with `appendFileSync`, one line per stdin read and per stdout write,
 * BEFORE the write is forwarded. That is deliberately slow, and it is the point: a blocked event
 * loop never reaches a timer, so a sampling probe records nothing about the very thing it is
 * there to catch. A synchronous trace stops exactly where the process stopped, and the last line
 * in the file says what it was doing.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "ink";
import { App } from "../dist/tui/app.js";
import { TuiController } from "../dist/tui/controller.js";

const LOG = "/tmp/agentrig-frame-probe.log";
writeFileSync(LOG, "");
const log = (m) => appendFileSync(LOG, `${m}\n`);

const started = Date.now();
const at = () => `+${Date.now() - started}ms`;

log(`columns=${process.stdout.columns} rows=${process.stdout.rows} TERM=${process.env.TERM ?? "?"}`);
log(`node=${process.version} platform=${process.platform}`);

if (process.stdin.isTTY !== true) {
  log("stdin is not a TTY; run this straight from a terminal");
  console.error("stdin is not a TTY; run this straight from a terminal");
  process.exit(1);
}

/** Ink's full-screen clear, spelled out so this file holds no control bytes of its own. */
const ESC = String.fromCharCode(27);
const CLEAR_TERMINAL = `${ESC}[2J`;

/** A hard stop, so a runaway cannot lock the terminal up while it is being measured. */
const MAX_WRITES = 4_000;
const MAX_BYTES = 40_000_000;

let writes = 0;
let bytes = 0;
let clears = 0;
let biggest = 0;
let reads = 0;
let readBytes = 0;
let stopped = false;

const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === "string" ? chunk : String(chunk);
  writes += 1;
  bytes += s.length;
  if (s.length > biggest) biggest = s.length;
  const cleared = s.includes(CLEAR_TERMINAL);
  if (cleared) clears += 1;
  // logged BEFORE the write, so a write that blocks forever still leaves its own record
  log(`${at()} write#${writes} len=${s.length}${cleared ? " CLEAR" : ""} total=${bytes}`);
  if (!stopped && (writes > MAX_WRITES || bytes > MAX_BYTES)) {
    stopped = true;
    log(`${at()} RUNAWAY: stopping at writes=${writes} bytes=${bytes} clears=${clears}`);
    log(`FINAL writes=${writes} bytes=${bytes} biggest=${biggest} clears=${clears} reads=${reads}`);
    process.exit(2);
  }
  return realWrite(chunk, ...rest);
};

// Ink pulls stdin with `read()` in a loop on 'readable'; this records exactly what it pulls, so a
// paste's chunk count and sizes can be compared against what the terminal delivered.
const realRead = process.stdin.read.bind(process.stdin);
process.stdin.read = (...args) => {
  const chunk = realRead(...args);
  if (chunk !== null && chunk !== undefined) {
    const len = String(chunk).length;
    reads += 1;
    readBytes += len;
    log(`${at()} read#${reads} len=${len} total=${readBytes}`);
  }
  return chunk;
};

process.on("uncaughtException", (e) => log(`${at()} UNCAUGHT ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`${at()} UNHANDLED ${e?.stack ?? e}`));
// ctrl-c reaches this only if the event loop is alive; its absence from the log is itself a result
process.on("SIGINT", () => log(`${at()} SIGINT`));

const controller = new TuiController({
  cwd: process.cwd(),
  agent: {
    run: () => {
      throw new Error("frame-probe has no agent; ctrl-c to finish");
    },
  },
});
// a session's worth of scrollback, since that is what a full repaint would reprint
const SCROLLBACK = Number(process.argv[2] ?? 300);
for (let i = 0; i < SCROLLBACK; i += 1) controller.print(`tool read some/path/to/file-${i}.ts`, "event");
log(`${at()} mounting with ${SCROLLBACK} scrollback lines`);

const instance = render(createElement(App, { controller }), {
  patchConsole: false,
  exitOnCtrlC: false,
});
log(`${at()} mounted`);

/**
 * Unconditional, so it distinguishes the two ways a TUI stops responding — which the first
 * version of this probe could not, because it only logged when the write count changed.
 *
 * A timer fires only when the event loop is free. So if these lines keep coming while stdin has
 * gone quiet, the loop is alive and the STREAM is stalled — and `readableLength` says whether the
 * rest of the paste is sitting in the buffer with nobody reading it. If they stop, the loop is
 * blocked and the last read/write line above says where.
 */
const beat = setInterval(() => {
  const s = process.stdin;
  log(
    `${at()} beat reads=${reads}/${readBytes}B writes=${writes}/${bytes}B ` +
      `readableLength=${s.readableLength} isPaused=${s.isPaused()} flowing=${String(s.readableFlowing)} ` +
      `readableListeners=${s.listenerCount("readable")} dataListeners=${s.listenerCount("data")} ` +
      `rawMode=${String(s.isRaw)} destroyed=${s.destroyed}`,
  );
}, 500);
beat.unref?.();

instance
  .waitUntilExit()
  .catch((e) => log(`${at()} EXIT ERROR ${e?.stack ?? e}`))
  .finally(() => {
    clearInterval(beat);
    log(`FINAL writes=${writes} bytes=${bytes} biggest=${biggest} clears=${clears} reads=${reads}`);
    realWrite(`\nwrote ${LOG}\n`);
  });
