// Isolated real Agent -> SessionStore -> TuiController -> App/Ink stream and frame probe.
// No fake timers, mocked append, debug renderer or render-to-string replacement.
import { distinctFrameCount, waitForDistinctFrames, selectFrameSamples } from './feel-frame-samples.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable, PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const req = createRequire(join(root, 'packages/cli/package.json'));
const { createElement } = await import(pathToFileURL(req.resolve('react')).href);
const { render } = await import(pathToFileURL(req.resolve('ink')).href);
const { createAgent, RulePolicy, defaultRules, SessionStore } = await import('../../core/dist/index.js');
const { TuiController } = await import('../dist/tui/controller.js');
const { App } = await import('../dist/tui/app.js');
const home = await mkdtemp(join(tmpdir(), 'r17c-stream-'));
let tick = 0, active = true, timer, firstByte, firstEvent, firstVisible;
function count() { if (active) { tick++; timer = setImmediate(count); } }
timer = setImmediate(count);
const delivered = new Map(), frames = [];
// Regression-only fixture: force a drained producer overshoot instead of relying
// on runner timing to leave two extra writes pending at the sixteen-write boundary.
const observedTarget = process.argv.includes('--overshoot-fixture') ? 18 : 16;
let writeId = 0;
const marker = i => `BYTE_${String(i).padStart(2, '0')}`;
const provider = {
  id: 'fake', model: 'feel-reference',
  capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
  async *stream() {
    // Ink may coalesce adjacent events. Keep producing real markers until sixteen
    // actual writes have been observed; never pad the measurement with duplicates.
    const deadline = performance.now() + 5000;
    for (let i = 0; distinctFrameCount(frames) < observedTarget && performance.now() < deadline; i++) {
      firstByte ??= { ms: performance.now(), tick };
      yield { type: 'text_delta', text: `${marker(i)} ` };
      // Let each event produce an actual frame instead of measuring a coalesced final answer.
      // Deterministic integration coverage for the coalescing mode seen on cold macOS.
      if (!(process.argv.includes('--coalesce-fixture') && i === 0)) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    yield { type: 'stop', reason: 'end_turn' };
  },
};
const agent = createAgent({ provider, store: new SessionStore({ root: home }), tools: [], permissions: new RulePolicy(defaultRules), systemPrompt: 'test', repoMap: false });
const run = agent.run.bind(agent);
agent.run = (...args) => {
  const session = run(...args);
  void (async () => {
    for await (const event of session.events) {
      if (event.type === 'model.delta') {
        const start = { ms: performance.now(), tick, cpu: process.cpuUsage() };
        firstEvent ??= start;
        delivered.set(event.text.trim(), start);
      }
    }
  })();
  return session;
};
const controller = new TuiController({ agent, cwd: home });
for (let i = 0; i < 2000; i++) controller.print(`historical tool result ${i}`, 'event');
const stdout = new Writable({ write(chunk, _encoding, callback) {
  const text = String(chunk);
  // Controlled slow sink: expose the first two markers together, not as two writes.
  if (process.argv.includes('--coalesce-fixture') && text.includes(marker(0)) && !text.includes(marker(1))) { callback(); return; }
  const frameId = ++writeId;
  for (const [key, start] of delivered) {
    if (!text.includes(key)) continue;
    const end = { ms: performance.now(), tick };
    const cpu = process.cpuUsage(start.cpu);
    firstVisible ??= end;
    frames.push({ frameId, event: 'model.delta', marker: key, cpuMs: (cpu.user + cpu.system) / 1000, latencyMs: end.ms - start.ms });
    delivered.delete(key);
  }
  callback();
} });
Object.assign(stdout, { isTTY: true, columns: 120, rows: 32 });
const stdin = new PassThrough();
Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
let mounted;
const mount = new Promise(resolve => { mounted = resolve; });
const ui = render(createElement(App, { controller, onMounted: mounted }), { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
try {
  await mount;
  await new Promise(resolve => setTimeout(resolve, 80));
  await controller.submit('return the streaming markers');
  await waitForDistinctFrames(frames, { target: observedTarget });
  assert.ok(firstByte && firstEvent && firstVisible, 'first byte must traverse the actual persisted and rendered stream');
  const samples = selectFrameSamples(frames);
  const result = {
    firstByteToEventMs: firstEvent.ms - firstByte.ms,
    firstByteToEventTicks: firstEvent.tick - firstByte.tick,
    firstByteToVisibleMs: firstVisible.ms - firstByte.ms,
    firstByteToVisibleTicks: firstVisible.tick - firstByte.tick,
    frameCount: distinctFrameCount(samples),
    observedFrameCount: distinctFrameCount(frames),
    sampledEvents: samples.length,
    maxFrameCpuMs: Math.max(...samples.map(frame => frame.cpuMs)),
    meanFrameCpuMs: samples.reduce((sum, frame) => sum + frame.cpuMs, 0) / samples.length,
    frames: samples,
  };
  console.log(JSON.stringify(result));
  assert.equal(result.frameCount, 16, 'must measure sixteen distinct real streamed writes, even with coalescing');
  assert.ok(result.firstByteToEventTicks <= 1, 'first byte -> canonical model.delta exceeded one event-loop tick');
  assert.ok(result.firstByteToVisibleTicks <= 1, 'first byte -> rendered stream exceeded one event-loop tick');
  assert.ok(result.maxFrameCpuMs < 16, 'TUI frame CPU cost per streamed event exceeded 16 ms');
} finally {
  active = false; clearImmediate(timer); ui.unmount(); await controller.shutdown();
  await rm(home, { recursive: true, force: true });
}
