import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';
import { validateAbortRestores } from '../src/run.js';
import { resolveConfig } from '../src/config.js';
import { ciRunOptions } from '../src/ci-run.js';
import { validateEvaluationProfile } from '../src/evaluation-fixtures.js';
import type { RunOptions } from '../src/run.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function resolved(argv: string[] = [], config?: object, protocolNotice = false, projectFiles: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recommended-'))); roots.push(root);
  const cwd = join(root, 'project'), home = join(root, 'home'); await mkdir(cwd); await mkdir(home);
  for (const [name, text] of Object.entries(projectFiles)) await writeFile(join(cwd, name), text);
  if (config) { await mkdir(join(home, '.agentrig')); await writeFile(join(home, '.agentrig/config.json'), JSON.stringify(config)); }
  let opts: RunOptions | undefined;
  await buildProgram({ config: { cwd, home, env: {}, ...(protocolNotice ? { notice: () => {} } : {}) }, run: async (_task, value) => { opts = value; } }).parseAsync(['run', 'task', ...argv], { from: 'user' });
  return opts!;
}
it('zero-config recommended profile enables existing conveniences without moving authority', async () => {
  const opts = await resolved();
  expect(opts).toMatchObject({ supervise: true, checkpoints: true, ingestOnEnd: true, memory: '.agentrig', notifications: 'bell' });
  expect(opts.diagnostics).toEqual([]);
  expect(opts.yolo).not.toBe(true); expect(opts.allow).toEqual([]); expect(opts.sandbox).toBe("none");
  expect(opts.supervisorReview).not.toBe(true); expect(opts.supervisorAbort).not.toBe(true);
});
it('recommended is a built-in profile and explicit false/empty config wins', async () => {
  expect(await resolved(['--profile', 'recommended'])).toMatchObject({ supervise: true, checkpoints: true });
  expect(await resolved([], { supervise: false, checkpoints: false, ingestOnEnd: false, notifications: 'off', diagnostics: [], toolSummaries: false }))
    .toMatchObject({ supervise: false, checkpoints: false, ingestOnEnd: false, notifications: 'off', diagnostics: [], verbose: true });
});
it.each(['read-only', 'workspace-write'])('implicit host hooks are visibly omitted under %s, explicit opt-ins are retained for the core refusal', async sandbox => {
  const notice = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await resolved(['--sandbox', sandbox])).toMatchObject({ checkpoints: false, ingestOnEnd: false, defaultHookNotice: expect.stringContaining('omitted implicit') });
  expect(notice.mock.calls.flat().join('\n')).toContain('recommended profile: omitted implicit checkpoints and session-end ingest');
  expect(await resolved(['--sandbox', sandbox], { checkpoints: true, ingestOnEnd: true })).toMatchObject({ checkpoints: true, ingestOnEnd: true });
});
it('migrated toggles are config-only and top-level help remains below forty options', () => {
  const p = buildProgram();
  expect(p.helpInformation().split('\n').filter(l => /^  -/.test(l)).length).toBeLessThan(40);
  for (const name of ['run', 'tui', 'acp', 'web', 'mcp-serve']) {
    const cmd = p.commands.find(c => c.name() === name)!;
    expect(cmd.options.map(o => o.long)).not.toEqual(expect.arrayContaining(['--supervise']));
    for (const flag of ['--supervise','--no-supervise','--checkpoints','--no-checkpoints','--ingest-on-end','--no-ingest-on-end','--notifications','--verbose'])
      expect(cmd.options.some(o => o.long === flag), flag).toBe(false);
  }
});
it.each(['checkpoints', 'ingestOnEnd'])('explicit %s still hits the unchanged core enforcing-sandbox startup guard', async key => {
  const { buildAgent } = await import('../src/agent-builder.js');
  const opts = await resolved(['--sandbox', 'workspace-write'], { [key]: true });
  vi.stubEnv('ANTHROPIC_API_KEY', 'local-fixture-only');
  try {
    await expect(buildAgent({ ...opts, memory: join(opts.extensionCwd!, 'memory'), root: join(opts.extensionCwd!, 'logs'), packages: false, extensionDiscovery: false }, { cwd: opts.extensionCwd }))
      .rejects.toThrow('sandbox modes cannot contain host-process hooks');
  } finally { vi.unstubAllEnvs(); }
});

it('a protocol adapter redacting arbitrary notices cannot hide the static omission from operator stderr', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  await resolved(['--sandbox', 'workspace-write'], undefined, true);
  expect(stderr.mock.calls.flat().join('\n')).toContain('recommended profile: omitted implicit checkpoints and session-end ingest');
});

it('implicit defaults cannot arm destructive abort restore; explicit user sources can', async () => {
  const flags = ['--supervisor-abort', '--supervisor-abort-restores'];
  expect(() => validateAbortRestores({ supervise: true, checkpoints: true, supervisorAbort: true, supervisorAbortRestores: true })).toThrow('explicit');
  const implicit = await resolved(flags);
  expect(() => validateAbortRestores(implicit)).toThrow('explicit');
  const explicit = await resolved(flags, { supervise: true, checkpoints: true });
  expect(() => validateAbortRestores(explicit)).not.toThrow();
});
it('shared resolver rejects an absent recommended profile', () => {
  expect(() => resolveConfig({ defaults: {}, profile: 'recommended' })).toThrow('unknown config profile');
});
it('CI normalizes persistent expanded display without changing security', async () => {
  const opts = await resolved([], { toolSummaries: false });
  expect(ciRunOptions(opts)).toMatchObject({ verbose: false, toolSummaries: true, headless: true });
  expect(() => ciRunOptions({ ...opts, json: true })).toThrow('CI refuses');
});
it.each([true, false])('evaluation accepts presentation-only toolSummaries=%s', value => {
  expect(() => validateEvaluationProfile({ toolSummaries: value })).not.toThrow();
});

it.each([{args: ['tui']}, {args: ['sessions', 'resume', 'fixture']}])('real $args handler receives recommended checkpoints', async ({args}) => {
  const root = await mkdtemp(join(tmpdir(), 'agentrig-entry-defaults-')); roots.push(root);
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  let received: {checkpoints?: boolean} | undefined;
  await buildProgram({config: {cwd, home, env: {}}, tui: async opts => { received = opts; }, run: async (_task, opts) => { received = opts; }}).parseAsync(['node', 'agentrig', ...args]);
  expect(received?.checkpoints).toBe(true);
});

it('implicit checkers skip config-less and reference-only roots and scope configured Python edits', async () => {
  expect((await resolved()).diagnostics).toEqual([]);
  expect((await resolved([], undefined, false, {'tsconfig.json': '{"references":[{"path":"./packages/a"}]}'})).diagnostics).toEqual([]);
  expect((await resolved([], undefined, false, {'tsconfig.json': '{"compilerOptions":{"noEmit":true}}'})).diagnostics).toEqual([expect.objectContaining({parser: 'tsc'})]);
  expect((await resolved([], undefined, false, {'pyproject.toml': '[project]\nname="fixture"'})).diagnostics).toEqual([expect.objectContaining({parser: 'ruff-json', args: ['check', '--output-format=json', '--', '{path}']})]);
});
it('one explicit restore prerequisite cannot borrow authority from the other implicit default', async () => {
  const flags = ['--supervisor-abort', '--supervisor-abort-restores'];
  for (const config of [{supervise: true}, {checkpoints: true}, {supervise: false, checkpoints: true}, {supervise: true, checkpoints: false}]) {
    const opts = await resolved(flags, config);
    expect(() => validateAbortRestores(opts)).toThrow();
  }
});
