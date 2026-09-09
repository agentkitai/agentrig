import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { expect, it } from 'vitest';
import { startAcp } from '../src/acp.js';
import { startMcpServe } from '../src/mcp-serve.js';
import { startWeb } from '../src/web.js';

it.each([{name:'acp', start:startAcp}, {name:'mcp-serve', start:startMcpServe}])('$name ignores expanded chat preference while preserving protocol-only output', async ({name,start}) => {
  const root = await mkdtemp(join(tmpdir(), 'agentrig-display-protocol-'));
  const cwd=join(root,'project'), home=join(root,'home'); await mkdir(cwd); await mkdir(home);
  const input = new PassThrough(), output = new PassThrough(); let text=''; output.on('data', c => {text+=String(c);});
  const command = new Command(name), flags = {root: join(root,'logs'), verbose:true,maxTurns:'5',maxTokensPerTurn:'100'};
  try {
    const running = start(command, flags, {config:{cwd,home,env:{}},input,output}); input.end();
    await expect(running).resolves.toBeUndefined(); expect(text).toBe('');
    await expect(start(command, {...flags,json:true}, {config:{cwd,home,env:{}},input,output})).rejects.toThrow('protocol-only');
  } finally {input.destroy();output.destroy();await rm(root,{recursive:true,force:true});}
});
it('Web ignores expanded chat preference without relaxing literal-loopback validation', async () => {
  await expect(startWeb(new Command('web'), {root:'unused',verbose:true,host:'localhost'})).rejects.toThrow('Web bind refused: use host 127.0.0.1');
  await expect(startWeb(new Command('web'), {root:'unused',verbose:true,json:true,host:'localhost'})).rejects.toThrow('raw-event');
});
