// src/modules/shared/word-count.ts
//
// SHAN-541. Counts the words a human actually reads in a markdown body, so a
// blog post can carry a denormalized word_count and every surface that shows
// "N min read" can derive it from the same number.
//
// This is a deliberate port of the counting half of the frontend's
// `apps/shell/lib/journal-text.ts` (`stripMarkdown` + `countWords`). It is
// duplicated rather than shared because the two repos never import from each
// other. Keep the two in step: if a pass is added there, add it here, or the
// stored count and a frontend fallback count stop agreeing.
//
// Only the passes that change the *count* matter, and they are the reason a
// whitespace split is not good enough:
//   - a fenced block collapses to a space, so code is not read-time prose
//   - heading, blockquote and list markers are control tokens, not words
//   - a junk-alt image (a filename, or the editor's "pasted-image") vanishes
// Inline emphasis, inline code and link/image text are unwrapped for parity
// with the frontend even though unwrapping them cannot change a token count.

const DATA_MARKER_RE = /\[\[data:[^|]+\|([^|]+)\|[\s\S]+?\]\]/g;

const JUNK_IMAGE_ALT_RE =
  /!\[(?:|pasted-image|[^\]\n]*\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif))\]\([^)]*\)/gi;

const MARKDOWN_PASSES: Array<[RegExp, string]> = [
  [/```[\s\S]*?```/g, " "],
  [/`([^`]+)`/g, "$1"],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s*[-*+]\s+/gm, ""],
  [/^\s*\d+\.\s+/gm, ""],
  [/^\s*[-*_]{3,}\s*$/gm, ""],
  [/(\*\*|__)(.+?)\1/g, "$2"],
  [/(?<!\w)([*_])(?=\S)([^*_\n]+?)(?<=\S)\1(?!\w)/g, "$2"],
  [/~~(.+?)~~/g, "$1"],
];

/** Markdown control tokens removed, prose left behind. */
function stripMarkdown(text: string): string {
  if (!text) return "";
  let out = text.replace(DATA_MARKER_RE, "$1").replace(JUNK_IMAGE_ALT_RE, "");
  for (const [re, sub] of MARKDOWN_PASSES) out = out.replace(re, sub);
  return out;
}

/**
 * Words in a markdown body. 0 for empty or markup-only input, which callers
 * render as "no reading time" rather than as a fabricated minimum.
 */
export function countBodyWords(text: string): number {
  const plain = stripMarkdown(text ?? "").trim();
  if (!plain) return 0;
  return plain.split(/\s+/).length;
}
