#!/usr/bin/env node
// Index live GitHub review comments, never a conductor-authored summary.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function commentSource(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(url);
  if (!match) throw new Error('expected a GitHub PR issuecomment URL');
  return { endpoint: `repos/${match[1]}/${match[2]}/issues/comments/${match[4]}`, issue: `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[3]}` };
}
export function findingIndex(url, comment) {
  commentSource(url);
  if (comment?.html_url !== url) throw new Error('live comment identity mismatch');
  if (typeof comment.body !== 'string') throw new Error('live comment body missing');
  const findings = [];
  let fence;
  for (const line of comment.body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    // Review skill requires per-finding headings. Other section headings are not findings.
    // Explicit delimiters distinguish severity labels from High-level prose.
    // Strip only Markdown's permitted ATX indentation; preserve original bytes.
    const candidate = line.replace(/^ {0,3}#{1,6} +/, '');
    const finding = /^(?:[A-Z]\d+\s+[—–-]\s+)?(?:\*\*)?(?:(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])(?:\*\*)?\s*(?::|—|–|-(?=\s)|,\s*(?:blocking|non-blocking)\s*—)|\[(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])\](?:\*\*)?\s+\S)/i.test(candidate);
    // ALL-CAPS ATX headings are finding attempts even without a supported delimiter.
    // Bare severity-token prose is not a heading; explicit finding syntax still indexes.
    // Priority planning sections are the explicit prose exception, not all P1 prose.
    const unsupportedOpening = /^ {0,3}#{1,6} +/.test(line) && /^(?:\*\*)?(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])\b/.test(candidate)
      && !/^P[0-3] planning notes(?:\s|$)/.test(candidate);
    if (finding) {
      findings.push({ comment: url, heading: line });
    } else if (!/^\s*>/.test(line) && (unsupportedOpening || /(?:\bF\d+\b.*\b(?:HIGH|MEDIUM|LOW|CRITICAL)\b|\[P\d+\]|^\s*(?:#{1,6}\s+)?(?:HIGH|MEDIUM|LOW|CRITICAL)\s*[:—])/i.test(line))) {
      throw new Error(`unindexed finding in ${url}: ${line}`);
    }
  }
  return findings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = process.argv[2];
    const source = commentSource(url);
    const result = spawnSync('gh', ['api', source.endpoint], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || 'live comment fetch failed');
    const comment = JSON.parse(result.stdout);
    if (comment.issue_url !== source.issue) throw new Error('live comment PR identity mismatch');
    console.log(JSON.stringify(findingIndex(url, comment), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
