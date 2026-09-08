// Run after pnpm build, separately from parallel unit-test load. Uses no live provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { assertColdStartBudget, assertFeelBudgets, FeelStreamMeasurement, FeelTaskMeasurement } from '../dist/feel-budgets.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = (command, args, env = process.env) => execFileSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
const terminal = () => z.object({ cold_start_to_prompt_ms: z.number().finite().nonnegative() }).parse(JSON.parse(run('python3', ['packages/cli/scripts/feel-terminal.py']))).cold_start_to_prompt_ms;
const coldStartMs = terminal();
console.log(`cold start control: ${coldStartMs.toFixed(3)} ms`);
assertColdStartBudget(coldStartMs);

// Required acceptance mutation: change the ACTUAL built CLI entry, not a fake measurement.
// The same PTY subprocess and same budget assertion must reject it. Restore even on failure.
const entry = join(root, 'packages/cli/dist/index.js');
const original = await readFile(entry);
let mutantKilled = false;
try {
  const source = original.toString('utf8');
  const newline = source.indexOf('\n') + 1;
  assert.ok(source.startsWith('#!') && newline > 0, 'expected the real CLI shebang');
  await writeFile(entry, source.slice(0, newline) + 'await new Promise(resolve => setTimeout(resolve, 450));\n' + source.slice(newline));
  const slowedMs = terminal();
  assert.ok(slowedMs >= 450, 'real startup mutation did not execute');
  try { assertColdStartBudget(slowedMs); }
  catch (error) { mutantKilled = true; console.log(`startup mutant KILLED: ${error.message}`); }
  assert.ok(mutantKilled, 'deliberately slowed real CLI unexpectedly passed the startup budget');
} finally { await writeFile(entry, original); }
assert.deepEqual(await readFile(entry), original, 'CLI entry bytes must be restored');

const stream = FeelStreamMeasurement.parse(JSON.parse(run(process.execPath, ['packages/cli/scripts/feel-stream.mjs'], { ...process.env, CI: 'false' })));
const coalescedRaw = JSON.parse(run(process.execPath, ['packages/cli/scripts/feel-stream.mjs', '--coalesce-fixture'], { ...process.env, CI: 'false' }));
const coalesced = FeelStreamMeasurement.parse(coalescedRaw);
assert.ok(coalescedRaw.sampledEvents > coalesced.frameCount, 'fixture must actually coalesce markers');
assert.ok(coalesced.frameCount >= 16, 'coalesced stream must still collect sixteen distinct writes');
console.log(`coalescing control: ${JSON.stringify(coalesced)}`);
const overshotRaw = JSON.parse(run(process.execPath, ['packages/cli/scripts/feel-stream.mjs', '--overshoot-fixture'], { ...process.env, CI: 'false' }));
const overshot = FeelStreamMeasurement.parse(overshotRaw);
assert.ok(overshotRaw.observedFrameCount >= 18, 'fixture must actually overshoot sixteen writes');
assert.equal(new Set(overshotRaw.frames.map(frame => frame.frameId)).size, 16);
console.log(`overshoot control: observed=${overshotRaw.observedFrameCount}, reported=${overshot.frameCount}`);
console.log(`stream/frame: ${JSON.stringify(stream)}`);
const e1Output = run(process.execPath, ['.agentrig/r17/task-baseline.mjs']);
process.stdout.write(e1Output);
const tasks = e1Output.split('\n').filter(line => line.startsWith('{')).map(line => FeelTaskMeasurement.parse(JSON.parse(line)));
const report = assertFeelBudgets({ measuredAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version, coldStartMs, stream, tasks });
await writeFile(join(root, 'packages/cli/dist/feel-results.json'), JSON.stringify({ ...report, startupMutantKilled: mutantKilled }, null, 2) + '\n');
if (process.argv.includes('--record')) {
  await writeFile(join(root, 'packages/cli/src/feel-reference.ts'), '// Measured by pnpm feel:check --record; not fabricated local-machine telemetry.\nexport const feelReference = ' + JSON.stringify(report, null, 2) + ' as const;\n');
}
console.log('PASS: all five feel budgets; startup mutation killed; exact CLI bytes restored');
