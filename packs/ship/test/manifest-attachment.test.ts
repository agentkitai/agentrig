// @ts-expect-error standalone helper
import { parseVerdict } from "../../../scripts/review-verdict.mjs";
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive:true,force:true}); });
const head = 'a'.repeat(40), sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture(mode = 'ok') {
  const root = mkdtempSync(join(tmpdir(),'manifest-')); roots.push(root);
  mkdirSync(join(root,'.agentrig')); mkdirSync(join(root,'durable'));
  writeFileSync(join(root,'.agentrig/config.json'), JSON.stringify({reviewers:{Peer:{adapter:'api:existing',model:'model'}}}));
  const verdict = {version:1,reviewedHead:head,slot:'Peer',assertedModel:'model',modelSource:'api:existing',verdict:'PASS',findings:[]};
  const output = `<!-- agentrig-verdict:v1 -->\n${JSON.stringify(verdict)}\n<!-- /agentrig-verdict -->\n`;
  const receipt = JSON.stringify({schema:1,repository:'o/r',pr:'7',pass:'initial',reviewedHead:head,slot:'Peer',model:'model',adapter:'api:existing',assertedModel:'model',transportModel:null,exit:0,verdict:parseVerdict(output),outputSha256:sha256(output)});
  const manifest = {receipt:join(root,'durable/provenance.json'),output:join(root,'durable/review.md'),sha256:sha256(receipt)};
  writeFileSync(manifest.receipt, receipt); writeFileSync(manifest.output, output);
  writeFileSync(join(root,'review'),mode === 'wrong-output' ? output+'different' : output);
  writeFileSync(join(root,'model'),'model');
  if(mode !== 'missing') writeFileSync(join(root,'review.durable.json'),JSON.stringify({...manifest,...(mode === 'digest' ? {sha256:'0'.repeat(64)} : {}),...(mode === 'locator' ? {output:join(root,'review')} : {})}));
  writeFileSync(join(root,'gh'),`#!/bin/sh\ncat "$5" > '${root}/posted'\nprintf 'https://github.com/o/r/pull/7#issuecomment-123\\n'\n`); chmodSync(join(root,'gh'),0o755);
  const env = {...process.env,PATH:`${root}:${process.env.PATH}`,AGENTRIG_REVIEW_REPOSITORY:'o/r',AGENTRIG_REVIEW_PR:'7',AGENTRIG_REVIEW_PASS:mode === 'pass' ? 'wrong' : 'initial'};
  const result = spawnSync(process.execPath,[resolve('scripts/post-review-comment.mjs'),'7','Peer',join(root,'model'),join(root,'review'),head,'b'.repeat(40),join(root,'comment')],{cwd:root,encoding:'utf8',env});
  return {root,manifest,result,posted:existsSync(join(root,'posted')) ? readFileSync(join(root,'posted'),'utf8') : undefined};
}
it('automatically attaches manifest and land validates it after scratch output deletion', () => {
  const f=fixture(); expect(f.result.status,f.result.stderr).toBe(0);
  expect(f.posted).toContain('<!-- agentrig-review-evidence:v1 -->'); expect(f.posted).toContain(JSON.stringify(f.manifest));
  rmSync(join(f.root,'review')); rmSync(join(f.root,'review.durable.json'));
  const land = spawnSync(process.execPath,[resolve('scripts/review-provenance.mjs'),'--comment',join(f.root,'posted'),'o/r','7','initial',head,'Peer','model','api:existing'],{encoding:'utf8'});
  expect(land.status,land.stderr).toBe(0); expect(JSON.parse(land.stdout).receipt.repository).toBe('o/r');
});
it.each(['missing','digest','locator','wrong-output','pass'])('fails before posting for invalid durable evidence %s', mode => {
  const f=fixture(mode); expect(f.result.status).not.toBe(0); expect(f.posted).toBeUndefined();
});

it.each(['missing attachment','duplicate attachment','changed live verdict','missing receipt','changed receipt','changed output'])('land fails closed: %s', mode => {
  const f=fixture(); expect(f.result.status,f.result.stderr).toBe(0);
  let body=f.posted!;
  if(mode === 'missing attachment') body=body.slice(0,body.indexOf('<!-- agentrig-review-evidence:v1 -->'));
  if(mode === 'duplicate attachment') body+=body.slice(body.indexOf('<!-- agentrig-review-evidence:v1 -->'));
  if(mode === 'changed live verdict') body=body.replace('"verdict":"PASS"','"verdict":"FAIL"');
  if(mode === 'missing receipt') rmSync(f.manifest.receipt);
  if(mode === 'changed receipt') writeFileSync(f.manifest.receipt,readFileSync(f.manifest.receipt,'utf8')+' ');
  if(mode === 'changed output') writeFileSync(f.manifest.output,'different');
  writeFileSync(join(f.root,'posted'),body);
  const land=spawnSync(process.execPath,[resolve('scripts/review-provenance.mjs'),'--comment',join(f.root,'posted'),'o/r','7','initial',head,'Peer','model','api:existing'],{encoding:'utf8'});
  expect(land.status).not.toBe(0);
});
