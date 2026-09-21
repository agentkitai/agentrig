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
  const headings = new Set(findingHeadings(body));
  let inFinding = false;
  let paragraphBoundary = false;
  let fence;
  let inline = false;
  const checked = [];
  const lines = body.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const quoted = fence !== undefined || marker !== undefined
      || /^ {0,3}>/.test(line) || /^(?: {4}|\t)/.test(line);
    if (!quoted && !inline && !line.trim()) paragraphBoundary = true;
    else {
      if (!quoted && !inline) {
        if (headings.has(line)) inFinding = true;
        else if (/^ {0,3}#{1,6} /.test(line)
          || /^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)
          || (paragraphBoundary && !/^\s*(?:Evidence:\s*)?`/.test(line))) inFinding = false;
      }
      // A separated quotation still belongs to the finding; a new unheaded
      // prose paragraph closes it rather than lending authority to later quotes.
      paragraphBoundary = false;
    }
    // Only quotation spans inside a supported finding are exempt. Keep
    // unquoted analysis subject to the guard, including on inline-code lines.
    if (inFinding && quoted) checked.push("\n[quoted evidence]\n");
    else if (inFinding) {
      const parts = line.split(/(`+)/);
      let text = "";
      for (let i = 0; i < parts.length; i++) {
        if (i % 2) {
          if (!inline) {
            // An unmatched backtick is prose, not a citation extending to EOF.
            const rest = parts.slice(i + 1).join("") + "\n" + lines.slice(lineIndex + 1).join("\n");
            const paragraph = rest.split(/\n[ \t]*\n|\n {0,3}#{1,6} /, 1)[0];
            if (paragraph.split(/(`+)/).some((part, index) => index % 2 && part === parts[i])) inline = parts[i];
          }
          else if (inline === parts[i]) inline = false;
          text += " [quoted evidence] ";
        } else if (!inline) text += parts[i];
      }
      checked.push(text);
    } else checked.push(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    }
  }
  // Reflow must not defeat literal echo detection. Markdown quote syntax is
  // not an exception outside a finding, so strip it before normalization.
  const text = checked.join("\n").replace(/^ {0,3}>[ \t]?/gm, "")
    .replace(/`+/g, "").replace(/\s+/g, " ");
  if (instructionEchoSentences.some(sentence => text.includes(sentence.replace(/\s+/g, " ")))) {
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
    if (finding) {
      findings.push(line);
    } else if (!/^\s*>/.test(line) && (unsupportedOpening || /^\s*(?:#{1,6}\s+)?(?:F\d+\b.*\b(?:HIGH|MEDIUM|LOW|CRITICAL)\b|\[P\d+\]|(?:HIGH|MEDIUM|LOW|CRITICAL)\s*[:—])/i.test(line))) {
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
