import { fileURLToPath } from "node:url";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionStore } from '@agentkitai/agentrig-core';
import { renderChatEvent } from '../src/render.js';
import { renderMarkdown } from '../src/tui/markdown.js';
const exec = promisify(execFile);
it('default CLI permits edits and approved background tests without checkpoint gates, preserving diagnostics and ingest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recommended-runtime-'));
  const cwd = join(root, 'project'), home = join(root, 'home'); await mkdir(cwd); await mkdir(home);
  let calls = 0, ingests = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const auxiliary = !parsed.tools?.length;
    if (auxiliary) ingests++;
    const step = auxiliary ? -1 : calls++;
    const call = step === 0 ? { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts', content: 'const n: number = 1;\n' }) }
      : step === 1 ? { name: 'bash', arguments: JSON.stringify({ command: 'echo background-test-passed', background: true }) }
      : step === 2 ? { name: 'bash_job', arguments: JSON.stringify({ id: 'job-1', action: 'status', waitMs: 8_000 }) } : undefined;
    const delta = call ? { tool_calls: [{ index: 0, id: `tool-${step}`, type: 'function', function: call }] }
      : { content: auxiliary ? '{"facts":[],"nothingDurable":true}' : '# Result\n\n**Ready**' };
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
  try {
    await exec('git', ['init', '-q'], { cwd });
    const { stdout, stderr } = await exec(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), 'run', 'Write a.ts then reply with Markdown',
      // Explicit write/exec approval, no YOLO, feature toggles, profile or config.
      '--provider', 'openai', '--model', 'gpt-4o', '--base-url', `http://127.0.0.1:${address.port}`, '--allow', 'write_file', '--allow', 'bash'],
    { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, OPENAI_API_KEY: 'local-fixture-only', NO_COLOR: '1' }, timeout: 30_000 });
    const store = new SessionStore({ root: join(cwd, '.agentrig/raw/sessions') });
    const [session] = await store.list(); expect(session).toBeDefined();
    const events = await store.readAll(session!.id);
    expect(events.some(e => e.type.startsWith('checkpoint.'))).toBe(false);
    expect(stdout + stderr).not.toContain('Checkpoint: turn');
    expect(events.filter(e => e.type === 'tool.denied' && e.id.startsWith('tool-'))).toEqual([]);
    expect(events.find(e => e.type === 'tool.result' && e.id === 'tool-1')).toMatchObject({ ok: true });
    expect(events.find(e => e.type === 'tool.result' && e.id === 'tool-2')).toMatchObject({ ok: true, display: expect.stringContaining('background-test-passed') });
    const diagnostic = events.find(e => e.type === 'tool.result' && e.diagnostics !== undefined);
    expect(diagnostic).toBeDefined(); expect(renderChatEvent(diagnostic!)).toContain('Diagnostics:');
    // The checker still needs exec approval; the default is NOT permission to execute it.
    expect(diagnostic?.type === 'tool.result' && diagnostic.diagnostics?.status).toBe('unavailable');
    expect(stdout + stderr).toContain('Diagnostics:');
    expect(ingests).toBe(1); expect(stdout + stderr).toContain('memory: ingested 0 fact(s) into 1 page(s)');
    const answer = events.find(e => e.type === 'message.append' && e.message.content.some(b => b.type === 'text' && b.text.includes('# Result')));
    expect(answer).toBeDefined();
    expect(renderMarkdown('# Result\n\n**Ready**', 80, true)).toContain('\u001b[1;36mResult');
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('const n');
    await expect(readFile(join(home, '.agentrig/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.agentrig/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
}, 40_000);
