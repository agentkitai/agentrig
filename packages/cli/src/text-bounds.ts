/** A UTF-8 byte prefix never substitutes a replacement character for a cut code point. */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let end = Math.max(0, Math.min(Math.floor(maxBytes), bytes.length));
  if (end === bytes.length) return text;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
