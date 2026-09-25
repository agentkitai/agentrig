// Bounded lexical view for hook intent detection, not shell execution.
export function shellIntentParts(command) {
  const segments = [[]], substitutions = [];
  let value = "", active = false, quote;
  const flush = () => { if (active) segments.at(-1).push(value); value = ""; active = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = undefined; else value += ch; continue; }
    if (ch === "'" && !quote) { quote = ch; active = true; continue; }
    if (ch === '"') { quote = quote ? undefined : ch; active = true; continue; }
    // Substitutions execute even inside double-quoted data. Inspect their
    // literal contents conservatively; never exempt a surrounding help flag.
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      const end = command.indexOf(ch === "`" ? "`" : ")", i + (ch === "`" ? 1 : 2));
      substitutions.push(command.slice(i + (ch === "`" ? 1 : 2), end < 0 ? undefined : end));
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
  return args.some(arg => /^(?:.*\/)?(?:sh|bash|dash|zsh|ksh|eval)$/u.test(arg));
}
