// Bounded lexical view for hook intent detection, not shell execution.
// Each nested substitution has its own quote context; quoted/escaped closing
// parentheses are data. An unfinished substitution conservatively owns the tail.
function substitutionEnd(command, start, backtick) {
  const stack = [{ quote: undefined, close: backtick ? "`" : ")" }];
  for (let i = start; i < command.length; i++) {
    const frame = stack.at(-1), ch = command[i];
    if (frame.quote === "'") { if (ch === "'") frame.quote = undefined; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === "`" && frame.close === "`" && !frame.quote) {
      stack.pop(); if (!stack.length) return i; continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      stack.push({ quote: undefined, close: ch === "`" ? "`" : ")" });
      if (ch === "$") i++;
      continue;
    }
    if (ch === '"') { frame.quote = frame.quote ? undefined : ch; continue; }
    if (frame.quote) continue;
    if (ch === "'") { frame.quote = ch; continue; }
    if (ch === "#" && (i === start || /[\s;|&()]/u.test(command[i - 1]))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "(") stack.push({ quote: undefined, close: ")" });
    else if (ch === frame.close) { stack.pop(); if (!stack.length) return i; }
  }
  return command.length;
}
export function shellIntentParts(command) {
  const segments = [[]], substitutions = [];
  let value = "", active = false, quote;
  const flush = () => { if (active) segments.at(-1).push(value); value = ""; active = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = undefined; else value += ch; continue; }
    if (!quote && !active && ch === "#") {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "'" && !quote) { quote = ch; active = true; continue; }
    if (ch === '"') { quote = quote ? undefined : ch; active = true; continue; }
    // Substitutions execute even inside double-quoted data. Inspect their
    // literal contents conservatively; never exempt a surrounding help flag.
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      const start = i + (ch === "`" ? 1 : 2);
      const end = substitutionEnd(command, start, ch === "`");
      substitutions.push(command.slice(start, end));
      // Expansion is one opaque part of the outer word, not outer quote syntax.
      value += "$(...)"; active = true; i = end; continue;
    }
    if (ch === "\\") {
      const next = command[++i];
      if (next === "\n") continue;
      if (next === "\r" && command[i + 1] === "\n") { i++; continue; }
      value += quote === '"' && next && !/[\\$`"\n]/u.test(next) ? "\\" + next : next ?? "";
      active = true; continue;
    }
    if (!quote && /[;&|<>\n\r()]/u.test(ch)) { flush(); segments.push([]); continue; }
    if (!quote && /\s/u.test(ch)) { flush(); continue; }
    value += ch; active = true;
  }
  flush();
  return { segments, substitutions };
}

export function shellWrapper(args) {
  return args.some(arg => /^(?:.*\/)?(?:sh|bash|dash|zsh|ksh|csh|tcsh|fish|eval)$/u.test(arg));
}
