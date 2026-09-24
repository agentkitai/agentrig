#!/usr/bin/env node
// Index live GitHub review comments, never a conductor-authored summary.
import { cliAdapters, normalizeReviewerHead } from "./reviewer-adapters.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verdictRange, hasVerdictBlock, parseVerdict, receiptTransport } from "./review-verdict.mjs";

// Current adapters already return verdict-only text (.last for Codex, .result for Claude).
// Also support old transcript artifacts without cutting a markerless verdict's provenance.
export function reviewerVerdict(raw, adapter) {
  const text = rawReviewerVerdict(raw, adapter);
  return hasVerdictBlock(text) ? text : normalizeReviewerHead(text).text;
}

function rawReviewerVerdict(raw, adapter) {
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

export function assertReviewerVerdict(body, expected = {}, log = console.warn) {
  if (hasVerdictBlock(body)) return parseVerdict(body, expected);
  log("review-verdict: legacy prose fallback (nonfatal); structured verdict required for landing");
  return null;
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
  assertReviewerVerdict(comment.body);
  return findingHeadings(comment.body, line => {
    console.warn(`review-verdict: prose divergence (nonfatal), unindexed finding or verdict inconsistency in ${url}: ${line}`);
  }).map(heading => ({ comment: url, heading }));
}

// Share heading recognition without fabricating live provenance for unposted text.
// Legacy unsupported openings are logged, not fatal; only schema can authorize landing.
export function findingHeadings(body, unsupported = () => {}) {
  if (hasVerdictBlock(body)) {
    const verdict = parseVerdict(body);
    const headings = verdict.findings.map(f => f.heading);
    // Inspect only surrounding prose, never JSON string values in the wire block.
    const range = verdictRange(body);
    const prose = body.slice(0, range.start) + body.slice(range.end);
    for (const heading of proseFindings(prose, unsupported, verdict.verdict)) {
      if (!headings.includes(heading)) unsupported(heading);
    }
    return headings;
  }
  return proseFindings(body, unsupported);
}

function proseFindings(body, unsupported, verdict) {
  const findings = [];
  let fence;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    // Nested list assertions remain diagnostic even at code-like indentation.
    // Actual fences/quotes and non-list indented code remain evidence/data.
    const nestedList = /^[ \t]+(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    if (/^\s*>/.test(line) || (/^(?: {4}|\t)/.test(line) && !nestedList)) continue;
    const proseVerdict = /^ {0,3}(?:#{1,6} +)?(?:\*\*)?VERDICT:\s*(PASS|FAIL)\b/i.exec(line);
    if (verdict && proseVerdict && proseVerdict[1].toUpperCase() !== verdict) unsupported(line);
    // Review skill requires per-finding headings. Other section headings are not findings.
    // Explicit delimiters distinguish severity labels from High-level prose.
    // Strip only Markdown's permitted ATX indentation; preserve original bytes.
    const candidate = line.replace(/^ {0,3}#{1,6} +/, '');
    const finding = /^(?:[A-Z]\d+\s+[—–-]\s+|F\d+:?\s+(?=\[))?(?:\*\*)?(?:(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])(?:\*\*)?\s*(?::|—|–|-(?=\s)|,\s*(?:blocking|non-blocking)\s*—)|\[(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])\](?:\*\*)?\s+\S)/i.test(candidate);
    // ALL-CAPS ATX headings are finding attempts even without a supported delimiter.
    // Bare severity-token prose is not a heading; explicit finding syntax still indexes.
    // Priority planning sections are the explicit prose exception, not all P1 prose.
    const unsupportedOpening = /^ {0,3}#{1,6} +/.test(line) && /^(?:\*\*)?(?:HIGH|MEDIUM|LOW|CRITICAL|P[0-3])\b/.test(candidate)
      && !/^P[0-3] planning notes(?:\s|$)/.test(candidate);
    if (finding) {
      findings.push(line);
    } else if (!/^\s*>/.test(line) && (unsupportedOpening || /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:#{1,6}\s+)?(?:\*{1,2}|_{1,2})?(?:F\d+\b.*\b(?:HIGH|MEDIUM|LOW|CRITICAL)\b|\[P\d+\]|(?:HIGH|MEDIUM|LOW|CRITICAL)\s*[:—])/i.test(line))) {
      unsupported(line);
    }
  }
  return findings;
}
export function runCli() {
  try {
    if (process.argv[2] === "--validate") {
      const [, , , input, reviewedHead, slot, assertedModel, provenance] = process.argv;
      if (![7, 8].includes(process.argv.length)) throw new Error("usage: --validate FILE HEAD SLOT MODEL [ADAPTER_PROVENANCE]");
      const body = readFileSync(input, "utf8");
      const expected = { reviewedHead, slot, assertedModel };
      if (provenance) expected.transportModel = receiptTransport(JSON.parse(readFileSync(provenance, "utf8")), expected, parseVerdict(body, { reviewedHead, slot }));
      const verdict = parseVerdict(body, expected);
      console.log(JSON.stringify(verdict, null, 2));
    } else if (process.argv[2] === "--extract") {
      const [, , , adapter, input, output] = process.argv;
      if (process.argv.length !== 6) throw new Error("usage: review-finding-index.mjs --extract ADAPTER INPUT OUTPUT");
      const raw = rawReviewerVerdict(readFileSync(input, "utf8"), adapter);
      const extracted = hasVerdictBlock(raw) ? { text: raw, tolerances: [] } : normalizeReviewerHead(raw);
      const body = extracted.text;
      if (!body.trim()) throw new Error("empty review");
      assertReviewerVerdict(body);
      writeFileSync(output, body);
      writeFileSync(`${output}.provenance.json`, JSON.stringify({ input, adapter, headExtraction: { tolerances: extracted.tolerances } }, null, 2) + "\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { runCli(); }
