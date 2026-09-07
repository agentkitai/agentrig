const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Delete one user-perceived character; preserve the retained text byte-for-byte. */
export function removeLastGrapheme(text: string): string {
  if (text === "") return text;
  const last = segmenter.segment(text).containing(text.length - 1)!;
  return text.slice(0, last.index);
}
