#!/usr/bin/env node
// Index live GitHub review comments, never a conductor-authored summary.
import { cliAdapters } from "./reviewer-adapters.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Current adapters already return verdict-only text (.last for Codex, .result for Claude).
// Also support old transcript artifacts without cutting a markerless verdict's provenance.
export function reviewerVerdict(raw, adapter) {
  if (adapter === "claude-cli" && raw.trimStart().startsWith("{")) {
    const { text } = cliAdapters[adapter].extract(raw);
    if (typeof text !== "string" || !text.trim()) throw new Error("empty review");
    return text;
  }
  if (adapter === "codex-cli" && /^OpenAI Codex\b/.test(raw)) {
    // Only a role marker followed by the verdict's opening is a boundary. A standalone
    // 'codex' inside a finding is content, not another role marker (never lastIndexOf).
    const boundary = /^codex\r?\n(?:[ \t]*\r?\n)*(?=(?:VERDICT:|Reviewed head|\*\*Findings\*\*|#{1,3} Findings|Full review comments:))/m.exec(raw);
    if (boundary) return raw.slice(boundary.index + boundary[0].length);
  }
  // In particular, keep VERDICT/Reviewed head before markerless Full review comments.
  return raw;
}

export const instructionEchoSentences = [
  "You are the reviewer of record, not the author and not the merger.",
  "A pass verdict lists what you probed and which mutants you ran",
  "Report which of the PR body's claims you verified, and any you could not.",
];
export function assertReviewerVerdict(body) {
  // Posting checks literal echoes, not live finding-index completeness or identity.
  const headings = new Set(findingHeadings(body));
  let inFinding = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^ {0,3}#{1,6} /.test(line)) inFinding = headings.has(line);
    else if (headings.has(line)) inFinding = true;
    // Narrow escape hatch: a Markdown blockquote inside an indexed finding. The
    // unquoted surrounding finding must still state the scenario and proposed fix.
    if (inFinding && /^ {0,3}> /.test(line)) continue;
    if (instructionEchoSentences.some(sentence => line.includes(sentence))) {
      throw new Error("reviewer body echoes instructions; not a verdict");
    }
  }
}

function commentSource(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(url);
  if (!match) throw new Error('expected a GitHub PR issuecomment URL');
  return { endpoint: `repos/${match[1]}/${match[2]}/issues/comments/${match[4]}`, issue: `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[3]}` };
}
export function findingIndex(url, comment) {
  commentSource(url);
  if (comment?.html_url !== url) throw new Error('live comment identity mismatch');
  if (typeof comment.body !== 'string') throw new Error('live comment body missing');
  return findingHeadings(comment.body, line => {
    throw new Error(`unindexed finding in ${url}: ${line}`);
  }).map(heading => ({ comment: url, heading }));
}

// Share heading recognition without fabricating live provenance for unposted text.
// Only the live index rejects recognizable unsupported finding openings.
function findingHeadings(body, unsupported = () => {}) {
  const findings = [];
  let fence;
  for (const line of body.split(/\r?\n/)) {
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
      findings.push(line);
    } else if (!/^\s*>/.test(line) && (unsupportedOpening || /(?:\bF\d+\b.*\b(?:HIGH|MEDIUM|LOW|CRITICAL)\b|\[P\d+\]|^\s*(?:#{1,6}\s+)?(?:HIGH|MEDIUM|LOW|CRITICAL)\s*[:—])/i.test(line))) {
      unsupported(line);
    }
  }
  return findings;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--extract") {
      const [, , , adapter, input, output] = process.argv;
      if (process.argv.length !== 6) throw new Error("usage: review-finding-index.mjs --extract ADAPTER INPUT OUTPUT");
      const body = reviewerVerdict(readFileSync(input, "utf8"), adapter);
      if (!body.trim()) throw new Error("empty review");
      assertReviewerVerdict(body);
      writeFileSync(output, body);
    } else {
      const url = process.argv[2];
      const source = commentSource(url);
      const result = spawnSync('gh', ['api', source.endpoint], { encoding: 'utf8' });
      if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || 'live comment fetch failed');
      const comment = JSON.parse(result.stdout);
      if (comment.issue_url !== source.issue) throw new Error('live comment PR identity mismatch');
      console.log(JSON.stringify(findingIndex(url, comment), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
