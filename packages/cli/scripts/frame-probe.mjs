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
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "ink";
import { App } from "../dist/tui/app.js";
import { TuiController } from "../dist/tui/controller.js";

const LOG = "/tmp/agentrig-frame-probe.log";
writeFileSync(LOG, "");
const log = (m) => appendFileSync(LOG, `${m}\n`);

log(`columns=${process.stdout.columns} rows=${process.stdout.rows} TERM=${process.env.TERM ?? "?"}`);
log(`node=${process.version} platform=${process.platform}`);

if (process.stdin.isTTY !== true) {
  log("stdin is not a TTY; run this straight from a terminal");
  console.error("stdin is not a TTY; run this straight from a terminal");
  process.exit(1);
}

/** Ink's full-screen clear, spelled out rather than pasted, so this file holds no control bytes. */
const CLEAR_TERMINAL = `${String.fromCharCode(27)}[2J`;

let writes = 0;
let bytes = 0;
let clears = 0;
let biggest = 0;
let wakeups = 0;
const started = Date.now();
const real = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === "string" ? chunk : String(chunk);
  writes += 1;
  bytes += s.length;
  if (s.length > biggest) biggest = s.length;
  // a full-screen clear means the frame went over the terminal's height
  if (s.includes(CLEAR_TERMINAL)) clears += 1;
  return real(chunk, ...rest);
};

process.on("uncaughtException", (e) => log(`UNCAUGHT ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`UNHANDLED ${e?.stack ?? e}`));

// a passive listener: Ink's own handler does the reading, this only counts the wakeups
process.stdin.on("readable", () => {
  wakeups += 1;
});

const controller = new TuiController({
  cwd: process.cwd(),
  agent: {
    run: () => {
      throw new Error("frame-probe has no agent; ctrl-c to finish");
    },
  },
});
// a session's worth of scrollback, since that is what a full repaint would reprint
for (let i = 0; i < 300; i += 1) controller.print(`tool read some/path/to/file-${i}.ts`, "event");

const instance = render(createElement(App, { controller }), {
  patchConsole: false,
  exitOnCtrlC: false,
});

let seen = 0;
const tick = setInterval(() => {
  if (writes === seen) return;
  seen = writes;
  log(
    `+${Date.now() - started}ms writes=${writes} bytes=${bytes} biggest=${biggest} clears=${clears} wakeups=${wakeups}`,
  );
}, 200);

instance
  .waitUntilExit()
  .catch((e) => log(`EXIT ERROR ${e?.stack ?? e}`))
  .finally(() => {
    clearInterval(tick);
    log(`FINAL writes=${writes} bytes=${bytes} biggest=${biggest} clears=${clears} wakeups=${wakeups}`);
    real(`\nwrote ${LOG}\n`);
  });
