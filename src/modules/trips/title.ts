// Tiny HTML title extractor. Regex-based, no full parser. Order of
// preference: <title>, then first <h1>, then "Untitled". Strips tags from
// inside <h1> so we don't surface "Tokyo &mdash; <span>day 1</span>" raw.

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

function clean(raw: string | undefined): string {
  if (!raw) return "";
  // Strip nested tags and collapse whitespace
  const noTags = raw.replace(/<[^>]+>/g, " ");
  return decodeBasicEntities(noTags).replace(/\s+/g, " ").trim();
}

export function extractTitle(html: string): string | null {
  const titleMatch = html.match(TITLE_RE);
  const fromTitle = clean(titleMatch?.[1]);
  if (fromTitle) return fromTitle.slice(0, 200);

  const h1Match = html.match(H1_RE);
  const fromH1 = clean(h1Match?.[1]);
  if (fromH1) return fromH1.slice(0, 200);

  return null;
}
