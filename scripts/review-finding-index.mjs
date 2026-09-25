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
// Match balanced code spans, including multi-backtick spans and wrapped citations.
// An escaped opening backtick is prose, not a quotation boundary.
function inlineCode(text, replacement) {
  return text.replace(/(?<![\\`])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, replacement);
}
export function assertReviewerVerdict(body) {
  // Posting does not enforce live-index completeness or invent comment provenance.
  const headings = new Set(findingHeadings(body));
  const lines = body.split(/\r?\n/);
  let inFinding = false, content = false, paragraphBreak = false;
  const unchecked = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (headings.has(line)) {
      inFinding = true; content = false; paragraphBreak = false;
    } else if (/^ {0,3}(?:#{1,6} |(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$)/.test(line)) {
      inFinding = false;
    }
    if (!line.trim()) {
      if (content) paragraphBreak = true;
      unchecked.push(line);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const quoted = /^ {0,3}> ?/.test(line) || /^(?: {4}|\t)/.test(line) || marker;
    // A new unquoted prose paragraph after the finding's scenario ends the escape.
    // Blank lines before its first paragraph or an explicit citation are harmless.
    // Inspect only this paragraph, and only when a boundary needs deciding.
    // Joining the entire remaining body on every line is quadratic on large posts.
    let rest = line;
    if (inFinding && paragraphBreak && !quoted) {
      for (let j = i + 1; j < lines.length && lines[j].trim(); j++) rest += "\n" + lines[j];
    }
    let inlineCitation = false;
    inlineCode(rest, (_span, _ticks, citation) => {
      if (instructionEchoSentences.some(sentence => citation.replace(/\s+/g, " ").includes(sentence))) inlineCitation = true;
      return "";
    });
    if (paragraphBreak && !quoted && !inlineCitation) inFinding = false;
    paragraphBreak = false;
    if (inFinding && marker) {
      const end = lines.findIndex((other, j) => j > i
        && new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(other));
      if (end !== -1) { i = end; unchecked.push("\0"); continue; }
      // Unclosed fences never grant a quotation escape.
      inFinding = false;
    }
    if (inFinding && quoted) { unchecked.push("\0"); continue; }
    // Gather a paragraph so a balanced inline citation may wrap across lines.
    let paragraph = line;
    if (inFinding && !headings.has(line)) {
      while (i + 1 < lines.length && lines[i + 1].trim()
        && !/^ {0,3}(?:#|>|`{3}|~{3}|(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$)/.test(lines[i + 1])) paragraph += "\n" + lines[++i];
      paragraph = inlineCode(paragraph, "\0");
      content = true;
    }
    unchecked.push(paragraph);
  }
  // Strip citation formatting even OUTSIDE findings: quoting the whole prompt is
  // still an echo. Whitespace normalization catches reflow, not paraphrases.
  const normalized = unchecked.join("\n").replace(/^ {0,3}> ?/gm, "")
    .replace(/`+/g, "").replace(/\s+/g, " ");
  if (instructionEchoSentences.some(sentence => normalized.includes(sentence.replace(/\s+/g, " ")))) {
    throw new Error("reviewer body echoes instructions; not a verdict");
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
    const fallback = /^\s*(?:\*\*)?(?:F\d+\b|\[P\d+\])/i.test(candidate) ? line : inlineCode(line, "");
    if (finding) {
      findings.push(line);
    } else if (!/^\s*>/.test(line) && (unsupportedOpening || /(?:\bF\d+\b.*\b(?:HIGH|MEDIUM|LOW|CRITICAL)\b|\[P\d+\]|^\s*(?:#{1,6}\s+)?(?:HIGH|MEDIUM|LOW|CRITICAL)\s*[:—])/i.test(fallback))) {
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
