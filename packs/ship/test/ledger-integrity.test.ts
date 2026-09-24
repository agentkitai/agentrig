import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const url = 'https://github.com/o/r/pull/7#issuecomment-456';
const old = '## Ledger\n- original finding → open\n';
async function probe(body: string, form = 'body', mode = 'ok', original = old, source = 'source') {
  const root = await mkdtemp(join(tmpdir(), 'ledger-')); roots.push(root);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'body'), body);
  await writeFile(join(root, 'patch'), JSON.stringify({ body }));
  const gh = join(root, 'bin/gh');
  await writeFile(gh, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(root,'calls'))},JSON.stringify(a)+'\\n');
if(${JSON.stringify(mode)}==='timeout'){setTimeout(()=>{},10000);return;}
if(a[0]==='pr') console.log(JSON.stringify({number:7,url:'https://github.com/o/r/pull/7',body:${JSON.stringify(original)}}));
else if(a[1]?.endsWith('/999')){process.exit(1);}
else if(${JSON.stringify(mode)}==='404'){process.exit(1);}
else console.log(JSON.stringify({id:456,html_url:${JSON.stringify(mode === 'wrong-url' ? url.replace('/7#','/8#') : url)},body:${JSON.stringify(source)}}));
`); await chmod(gh, 0o755);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const command = form === 'double-backslash' ? `gh pr edit 7 --body "${body}"` : form === 'typed' ? `gh api repos/o/r/pulls/7 -X PATCH -F body=${quote(body)}` : form === 'mixed-repo' ? `gh api repos/{owner}/other/pulls/7 -X PATCH -f body=${quote(body)}` : form === 'wrapped' ? `true; gh pr edit 7 --body ${quote(body)}` : form === 'attached' ? `gh pr edit 7 -b${quote(body)}` : form === 'quoted' ? `gh 'pr' 'edit' 7 --body ${quote(body)}` : form === 'api-attached' ? `gh api -XPATCH repos/o/r/pulls/7 -f${quote('body='+body)}` : form === 'file' ? 'gh pr edit 7 --body-file body' : form === 'patch' ? 'gh api repos/o/r/pulls/7 -X PATCH --input patch' : form === 'field' ? `gh api repos/o/r/pulls/7 --method PATCH -f body=${quote(body)}` : `gh pr edit 7 --body ${quote(body)}`;
  const mod = await import(/* @vite-ignore */ pathToFileURL(resolve('.agentrig/extensions/dispatch-record.mjs')).href);
  const hook = mod.createDispatchHook({ gh, budgetMs: mode === 'timeout' ? 80 : 3000 });
  const result = await hook({cwd:root, tool:{name:'bash',input:{command}},sessionId:'s'});
  return { result, calls: await readFile(join(root,'calls'),'utf8').catch(()=> '') };
}
it.each(['body','file','patch','field','attached','quoted','api-attached'])('denies destructive ledger rewrite via %s', async form => {
  expect((await probe('## Ledger\n- original finding → resolved\n',form)).result.action).toBe('deny');
});
it.each(['body','file','patch','field','attached','quoted','api-attached'])('allows byte-prefix append after fetched source validation via %s', async form => {
  const p = await probe(old + `- resolution evidence ${url}\n`,form);
  expect(p.result.action).toBe('continue'); expect(p.calls).toContain('issues/comments/456');
});
it.each(['404','wrong-url','timeout'])('unverified cited source %s fails closed', async mode => {
  expect((await probe(old + `- evidence ${url}\n`,'body',mode)).result.action).toBe('deny');
});
it('rejects stripping earlier rows even if a new ledger is longer', async () => {
  expect((await probe('## Ledger\n' + 'replacement '.repeat(100))).result.action).toBe('deny');
});
it('permits a no-op without source changes', async () => { expect((await probe(old)).result.action).toBe('continue'); });
it('rejects source URLs for another PR before permitting append', async () => { expect((await probe(old + url.replace('/7#','/8#'))).result.action).toBe('deny'); });
it('allows initial body population', async () => { expect((await probe('summary','body','ok','')).result.action).toBe('continue'); });

it('rejects a source URL whose anchor only starts with a real comment ID', async () => {
  expect((await probe(old + url + 'missing')).result.action).toBe('deny');
});
it('denies shell wrapping of an otherwise valid body mutation', async () => {
  expect((await probe(old, 'wrapped')).result.action).toBe('deny');
});

const sourceHeading = '  exact "quote" \\ ` ** café -> → ; |  ';
const structuredSource = `<!-- agentrig-verdict:v1 -->\n${JSON.stringify({version:1,reviewedHead:'a'.repeat(40),assertedModel:'model',modelSource:'self',slot:'Peer',verdict:'FAIL',findings:[{severity:'HIGH',heading:sourceHeading,location:'file:1',blocking:true,scenario:'proof'}]})}\n<!-- /agentrig-verdict -->`;
it.each(['body','file','patch','field'])('PR-body guard rejects an appended misquoted structured heading: %s', async form => {
  const body=old+`Finding identities: ${JSON.stringify([{heading:sourceHeading.trim(),url}])}\n`;
  expect((await probe(body,form,'ok',old,structuredSource)).result.action).toBe('deny');
});
it('PR-body guard accepts exact decoded source identity bytes', async () => {
  const body=old+`Finding identities: ${JSON.stringify([{heading:sourceHeading,url}])}\n`;
  expect((await probe(body,'body','ok',old,structuredSource)).result.action).toBe('continue');
});
it('a structured finding source requires a mechanically identified heading, not prose approximation', async () => {
  expect((await probe(old+`paraphrase ${url}`,'body','ok',old,structuredSource)).result.action).toBe('deny');
});
it('double-quoted backslashes cannot make a destructive body look unchanged', async () => {
  expect((await probe('foo\\bar','double-backslash','ok','foobar')).result.action).toBe('deny');
});
it('typed null cannot masquerade as the literal body string null', async () => {
  expect((await probe('null','typed','ok','null')).result.action).toBe('deny');
});
it('partial API repository placeholders cannot validate a different repo', async () => {
  expect((await probe(old,'mixed-repo')).result.action).toBe('deny');
});
it.each([
  'gh api repos/o/r/pulls',
  'gh api repos/o/r/pulls/7/reviews',
  'gh api repos/o/r/pulls/7/comments --method GET',
  'gh api repos/o/r/pulls/comments/123',
  'gh api repos/o/r/pulls/7/reviews -X POST -f body=note',
])('does not block non-body API operations: %s', async command => {
  const mod = await import(/* @vite-ignore */ pathToFileURL(resolve('.agentrig/extensions/dispatch-record.mjs')).href);
  const hook = mod.createDispatchHook({gh:'/not-an-executable'});
  expect((await hook({cwd:tmpdir(),tool:{name:'bash',input:{command}},sessionId:'s'})).action).toBe('continue');
});

// #571 names receipt history explicitly: pin those bytes through both body transports.
const roundOne = '## Ledger\nRepair round: 1/3\nPre-dispatch read-back: Repair round: 1/3; blockers X1; OLD ' + 'a'.repeat(40) + '; verified 2026-09-24T00:00:00Z\n';
const roundTwo = 'Repair round: 2/3\nPre-dispatch read-back: Repair round: 2/3; blockers X2; OLD ' + 'b'.repeat(40) + '; verified 2026-09-24T01:00:00Z\n';
it.each(['body', 'patch'])('appends literal round-2 receipts without changing round-1 via %s', async form => {
  expect((await probe(roundOne + roundTwo, form, 'ok', roundOne)).result.action).toBe('continue');
});
it.each(['body', 'patch'])('denies rewriting the literal round-1 receipt via %s', async form => {
  const rewritten = roundOne.replace('\nRepair round: 1/3\n', '\nRepair round: 2/3 (round 1/3 history retained below)\n');
  expect((await probe(rewritten, form, 'ok', roundOne)).result.action).toBe('deny');
});
it.each(['body', 'patch'])('denies changing the literal round-1 read-back while appending round-2 via %s', async form => {
  const rewritten = roundOne.replace('Pre-dispatch read-back: Repair round: 1/3', 'Pre-dispatch read-back: Repair round: 2/3') + roundTwo;
  expect((await probe(rewritten, form, 'ok', roundOne)).result.action).toBe('deny');
});
it.each(['body', 'patch'])('allows appending the same literal receipt round again via %s', async form => {
  expect((await probe(roundOne + roundOne, form, 'ok', roundOne)).result.action).toBe('continue');
});

const deadUrl = url.replace('456', '999');
it.each(['body', 'patch'])('recovers by valid append without refetching dead protected history via %s', async form => {
  const history = roundOne + `Historical evidence ${deadUrl}\n`;
  const p = await probe(history + `Resolution evidence ${url}\n`, form, 'ok', history);
  expect(p.result.action).toBe('continue');
  expect(p.calls).toContain('issues/comments/456');
  expect(p.calls).not.toContain('issues/comments/999');
  expect((await probe(history.replace('Repair round: 1/3', 'Repair round: 2/3') + url, form, 'ok', history)).result.action).toBe('deny');
});
it.each(['body', 'patch'])('denies newly appended dead links including repeated historic links via %s', async form => {
  for (const history of [old, old + deadUrl + '\n']) {
    expect((await probe(history + deadUrl, form, 'ok', history)).result.action).toBe('deny');
  }
});
it.each(['body', 'patch'])('refetches repeated finding sources and validates exact new headings via %s', async form => {
  const history = old + `Historical evidence ${url}\n`;
  const addition = (heading: string) => `Finding identities: ${JSON.stringify([{heading, url}])}\n`;
  const p = await probe(history + addition(sourceHeading), form, 'ok', history, structuredSource);
  expect(p.result.action).toBe('continue');
  expect(p.calls).toContain('issues/comments/456');
  expect((await probe(history + addition(sourceHeading.trim()), form, 'ok', history, structuredSource)).result.action).toBe('deny');
  expect((await probe(history + addition(sourceHeading), form, '404', history, structuredSource)).result.action).toBe('deny');
});
