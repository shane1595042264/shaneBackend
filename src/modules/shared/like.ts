// src/modules/shared/like.ts
//
// SHAN-545. One place to turn a user's search box contents into an ILIKE
// pattern, because doing it inline is a trap that this repo has already
// stepped in twice.
//
// `%` and `_` are LIKE metacharacters. A pattern built as `%${term}%` hands
// whatever the user typed to Postgres as *pattern syntax*, so the two
// characters a search can least afford to lose are the two it silently
// reinterprets:
//
//   search=_   ->  %_%   ->  "any string with at least one character"
//   search=%   ->  %%%   ->  "any string at all"
//
// Both return the entire table rather than the rows that contain that
// character. Measured on prod before this fix: `/api/vocabulary/words` and
// `/api/knowledge/entries` each reported `total: 48` out of 48 rows for both
// queries, while a normal term (`a`) correctly reported 47. Underscores are
// not a hypothetical query here either — the vocab table is full of coding
// terms like snake_case and __init__.
//
// The escape character is the Postgres default backslash, which is why the
// backslash itself has to be escaped first (and why the character class below
// lists it first: the replace is single-pass, so a `\` produced by escaping a
// `%` is never re-escaped).
//
// blog/posts-repo.ts and journal/entries-repo.ts each already carried this
// logic as a copy-pasted one-liner; knowledge/routes.ts and
// vocabulary/routes.ts were written later and were never given a copy. That is
// the whole reason it lives here now: the next module that grows a search box
// imports the fix instead of remembering it. tests/modules/shared/like.test.ts
// fails the suite if a new call site builds a pattern inline again.

const LIKE_METACHARACTERS = /[\\%_]/g;

/**
 * A search term with the LIKE metacharacters (`\`, `%`, `_`) escaped so they
 * match as themselves. Returns the term only; callers that want a substring
 * match should use {@link likeContains}.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(LIKE_METACHARACTERS, (ch) => `\\${ch}`);
}

/**
 * A `%term%` substring pattern, safe to pass straight to drizzle's `ilike()`
 * or to interpolate as a bound parameter into a raw `... ILIKE ${pattern}`.
 *
 * Do not wrap the result in `%` again, and do not build the pattern by hand
 * next to a call to this function — a half-escaped pattern reads as working
 * for every term that happens to contain neither metacharacter.
 */
export function likeContains(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}
