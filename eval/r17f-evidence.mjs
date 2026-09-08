// R17f publication receipts. Reads model-created files only inside the isolated worker.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { saveEvaluationArtifact } from '../packages/cli/dist/evaluation-attempt.js';

export const CAPTURE = `const fs=require('fs'),path=require('path');
const requested=JSON.parse(process.argv[1]);const files=[],skipped=[];let bytes=0;
for(const p of requested){
  if(files.length>=64){skipped.push({path:p,reason:'file-count bound'});continue}
  if(typeof p!=='string'||p.includes('\\\\')||p.split('/').some(s=>!s||s==='.'||s==='..')){skipped.push({path:p,reason:'unsafe path'});continue}
  try{
    let cursor='.';for(const part of p.split('/')){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())throw Error('symlink')}
    const stat=fs.lstatSync(p);if(!stat.isFile())throw Error('not regular');
    if(stat.size>256000||bytes+stat.size>1048576)throw Error('byte bound');
    const value=fs.readFileSync(p);if(value.length>256000||bytes+value.length>1048576)throw Error('byte bound');
    bytes+=value.length;files.push({path:p,base64:value.toString('base64')});
  }catch(e){skipped.push({path:p,reason:e.code==='ENOENT'?'absent':'unavailable or outside capture bounds'})}
}console.log(JSON.stringify({files,skipped,bytes}));`;

const safePath = p => typeof p === 'string' && p.length <= 4096 && !p.includes('\\')
  && p.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

/** Called after the model/observer and checker settle. Capture failures are explicit, not passes. */
export async function captureEvidence(transport, worker, receipt, task, directory) {
  const signal = AbortSignal.timeout(120_000);
  const diff = await transport.worker(worker,
    ['git', 'diff', '--no-ext-diff', '--no-textconv', '--binary', receipt.baseline, '--'], signal, 60_000);
  await saveEvaluationArtifact(join(directory, 'diff.json'), diff);
  const added = await transport.worker(worker, ['git', 'ls-files', '--others', '--exclude-standard', '-z'], signal, 60_000);
  await saveEvaluationArtifact(join(directory, 'new-paths.json'), added);
  const candidates = [...new Set([...task.allowed, ...added.stdout.split('\0').filter(Boolean)])];
  const paths = candidates.filter(safePath).slice(0, 128);
  const captured = await transport.worker(worker, ['node', '-e', CAPTURE, JSON.stringify(paths)], signal, 60_000);
  const receiptData = { diffComplete: diff.code === 0 && !diff.infrastructure,
    inventoryComplete: added.code === 0 && !added.infrastructure,
    pathsOmitted: candidates.length - paths.length, captured: [], skipped: [], complete: false };
  if (captured.code === 0 && !captured.infrastructure) {
    const data = JSON.parse(captured.stdout);
    if (!Array.isArray(data.files) || data.files.length > 64 || !Array.isArray(data.skipped))
      throw new Error('invalid isolated artifact capture');
    let total = 0;
    for (const file of data.files) {
      if (!safePath(file.path) || !paths.includes(file.path) || typeof file.base64 !== 'string')
        throw new Error('invalid isolated artifact path');
      const bytes = Buffer.from(file.base64, 'base64');
      total += bytes.length;
      if (bytes.length > 256000 || total > 1048576) throw new Error('isolated artifact capture exceeds bounds');
      const destination = join(directory, 'artifacts', file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
      receiptData.captured.push(file.path);
    }
    receiptData.skipped = data.skipped;
    receiptData.complete = receiptData.diffComplete && receiptData.inventoryComplete
      && receiptData.pathsOmitted === 0 && data.skipped.every(item => item.reason === 'absent');
  } else receiptData.skipped.push({ reason: 'isolated capture process failed', code: captured.code });
  await saveEvaluationArtifact(join(directory, 'artifact-capture.json'), receiptData);
  return receiptData;
}
