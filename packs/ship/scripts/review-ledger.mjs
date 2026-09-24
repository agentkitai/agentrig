import { FindingIdentities } from "./ledger-schema.mjs";
import { findingHeadings } from "./review-finding-index.mjs";

// Protocol fields are operative lines, not occurrences in quoted history or examples.
// Keep every remaining byte: heading whitespace/Markdown is identity, not decoration.
export function operativeLines(task) {
  let fence;
  return task.split(/\r?\n/u).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return "";
    }
    if (marker) { fence = marker; return ""; }
    return /^\s*>/u.test(line) ? "" : line;
  });
}

export function assignedFindings(lines) {
  const identities = lines.filter(line => line.startsWith("Finding identities: "));
  if (identities.length) {
    if (identities.length !== 1) throw new Error("duplicate Finding identities field");
    const rows = FindingIdentities.parse(JSON.parse(identities[0].slice("Finding identities: ".length)));
    return rows.map(row => ({ heading: row.heading, urls: [row.url] }));
  }
  const legacy = new Set(findingHeadings(lines.join("\n")));
  const sources = lines.map(line => [...line.matchAll(/https:\/\/github\.com\/[^\s<>`\)]+/gu)].map(match => match[0].replace(/:$/u, "")));
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const explicit = /^(?:[A-Z]\d+ heading: |Finding: )(.*)$/u.exec(line);
    // Existing ship tasks also paste a raw heading followed by Source: URL.
    // No severity grammar applies to that heading, including schema headings.
    const beforeSource = /^Source: https:\/\/github\.com\//u.test(lines[index + 1] ?? "")
      && line.length && !sources[index].length && !/^(?:Repair round:|Pre-dispatch read-back:)/u.test(line);
    const heading = explicit ? explicit[1] : legacy.has(line) || beforeSource ? line : undefined;
    if (heading !== undefined && heading.trim()) headings.push({ heading, index });
  }
  return headings.map((entry, i) => {
    // A named source-first group starts a new association, not a trailing source
    // for the last heading of the previous reviewer.
    const following = sources.slice(entry.index, headings[i + 1]?.index ?? lines.length)
      .flatMap((urls, offset) => /^.+ source https:\/\//iu.test(lines[entry.index + offset]) ? [] : urls);
    // Source-first groups (e.g. Claude source URL; C1 heading: ...; C2 heading: ...).
    const preceding = sources.slice(0, entry.index).findLast(urls => urls.length) ?? [];
    return { ...entry, urls: following.length ? following : preceding };
  });
}

