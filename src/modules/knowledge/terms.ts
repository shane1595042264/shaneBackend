/**
 * SHAN-712: the knowledge base as a glossary. Every card with a definition is
 * a term the reading surfaces (journal, blog, courses) can underline: the
 * strings in a text that point at it, and a definition short enough for a
 * popover. Matching itself runs in the browser (shaneFrontend
 * lib/knowledge-terms.ts); this only decides which strings a card answers to.
 */

export interface TermSource {
  id: string;
  word: string;
  definition: string | null;
  category: string;
  language: string;
  partOfSpeech: string | null;
  pronunciation: string | null;
}

export interface KnowledgeTerm {
  id: string;
  word: string;
  /** The strings in a text that point at this card, longest first. */
  match: string[];
  definition: string;
  category: string;
  language: string;
  partOfSpeech: string | null;
  pronunciation: string | null;
}

/** More cards than this and the index stops growing; the newest win. */
export const MAX_TERMS = 5000;
export const MAX_DEFINITION = 360;
const MAX_MATCH_LENGTH = 48;
const MAX_MATCH_WORDS = 5;

// Scripts written without spaces between words. The browser matches their
// terms without word boundaries, so two characters already make a term.
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function usable(s: string): boolean {
  if (!/\p{L}/u.test(s)) return false;
  if (s.length > MAX_MATCH_LENGTH || s.split(" ").length > MAX_MATCH_WORDS) return false;
  return s.length >= (DENSE.test(s) ? 2 : 3);
}

/**
 * The strings a card's word answers to. Words come from people and from the
 * classifier, so they are not always a clean term:
 * - "[Choreo] Jazz combo": a leading tag in brackets is dropped.
 * - "SSRF: SSRF stands for ...": a short label before ": " is the term (the
 *   classifier's fallback sometimes stores a whole sentence as the word).
 * - "Data Subject Access Request (DSAR)": the phrase and, when it is one token
 *   (an acronym, a word in another script), the part in parentheses. A longer
 *   aside in parentheses describes the term rather than naming it.
 * Anything left that is too long to be said in passing (over 48 characters or
 * five words) matches nothing.
 */
export function termMatches(word: string): string[] {
  let w = collapse(word).replace(/^\[[^\]]*\]\s*/, "");
  const label = w.match(/^([^:]{1,32}):\s+\S/);
  if (label) w = label[1].trim();
  const out: string[] = [];
  const paren = w.match(/^(.*?)\s*\(([^()]*)\)\s*(.*)$/);
  if (paren) {
    out.push(collapse(`${paren[1]} ${paren[3]}`));
    const inner = collapse(paren[2]);
    if (inner && !inner.includes(" ")) out.push(inner);
  } else {
    out.push(w);
  }
  return [...new Set(out.filter(usable))].sort((a, b) => b.length - a.length);
}

/**
 * One paragraph of plain-ish text, cut on a word near MAX_DEFINITION.
 *
 * The popover renders only paragraphs, emphasis and code (SHAN-716), so an
 * image is dropped and a link keeps just its text before the cut: an image
 * would render as nothing, and a cut inside `![alt](https://...` or
 * `[text](https://...` is no longer markdown and prints as raw syntax.
 */
export function shortDefinition(text: string): string {
  const t = collapse(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
  );
  if (t.length <= MAX_DEFINITION) return t;
  const cut = t.slice(0, MAX_DEFINITION);
  const space = cut.lastIndexOf(" ");
  const kept = space > MAX_DEFINITION * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.\-]+$/, "")}…`;
}

/**
 * Rows newest first. A string two cards both answer to (the same word saved
 * twice) belongs to the newer card, compared without case; a card left with no
 * string of its own, or with no definition to show, is not a term.
 */
export function buildTermIndex(rows: TermSource[]): KnowledgeTerm[] {
  const claimed = new Set<string>();
  const terms: KnowledgeTerm[] = [];
  for (const row of rows) {
    const definition = shortDefinition(row.definition ?? "");
    if (!definition) continue;
    const match = termMatches(row.word).filter((m) => {
      const key = m.toLowerCase();
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    if (match.length === 0) continue;
    terms.push({
      id: row.id,
      word: collapse(row.word),
      match,
      definition,
      category: row.category,
      language: row.language,
      partOfSpeech: row.partOfSpeech,
      pronunciation: row.pronunciation,
    });
  }
  return terms;
}
