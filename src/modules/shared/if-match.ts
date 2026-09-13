/**
 * Reads the optimistic-concurrency version from a request, accepting either
 * spelling of the header.
 *
 * `If-Match` is the documented header and stays that way for direct callers (a
 * PAT plus curl against the Railway origin). Browsers must send `X-If-Match`
 * instead: their requests are same-origin and ride the rewrite through Vercel's
 * edge (SHAN-458), which evaluates a real `If-Match` against the response ETag.
 * Every 200 JSON response carries a WEAK ETag (see `conditional-get.ts`), and a
 * weak validator can never satisfy `If-Match`, which requires strong
 * comparison — so the edge replaced the origin's 200 with a 412 AFTER the write
 * had committed. The client saw a failure on a save that succeeded, and the
 * retry wrote it a second time. Error responses carry no ETag, which is why the
 * 409 and 428 paths looked perfect and this stayed hidden (SHAN-487 for the
 * blog, SHAN-489 for the journal).
 *
 * `If-Match` wins if both are sent.
 */
export function readIfMatch(c: { req: { header(name: string): string | undefined } }) {
  return c.req.header("If-Match") ?? c.req.header("X-If-Match");
}
