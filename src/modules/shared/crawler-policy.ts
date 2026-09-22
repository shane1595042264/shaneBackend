import { createMiddleware } from "hono/factory";

/**
 * Crawler policy for the backend origin (SHAN-520).
 *
 * Found in the Railway deployment log: search engines were requesting
 * `GET /robots.txt` on shanebackend-production.up.railway.app and getting a
 * 404. A 404 on robots.txt is not "no robots file", it is "no restrictions" —
 * every route on this origin was fair game to crawl and index. Nothing links
 * here, but Railway hostnames are enumerable from certificate transparency
 * logs, which is how a bot finds an origin no page points at.
 *
 * Three things were at stake:
 *
 *  1. This origin serves the same JSON as shanejli.com/api/* (the next.config
 *     rewrite from SHAN-458 proxies the whole API onto the canonical domain).
 *     An indexed copy here is an uncanonicalised duplicate, and JSON cannot
 *     carry a rel=canonical, so there would be no way to consolidate it after
 *     the fact.
 *  2. SHAN-458 and SHAN-477 went to real lengths to keep this hostname out of
 *     browsers — a corporate proxy intercepts it and Cisco Umbrella DNS-blocks
 *     it. A search result pointing straight at it hands a user the one URL
 *     that is known to fail for them.
 *  3. Bots walking the paginated list endpoints run real queries against the
 *     single production Postgres.
 */

/**
 * `Disallow: /` rather than a per-path list: nothing on this origin is a page,
 * and a crawler has no business anywhere on it.
 *
 * Trailing newline because some parsers are strict about the final record.
 */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Sent on every response. The two controls do different jobs and neither
 * replaces the other:
 *
 *  - robots.txt stops the crawl. It does NOT remove anything already indexed,
 *    and a crawler that is blocked from a URL can never fetch it to discover
 *    this header. That ordering hazard was checked rather than assumed: a
 *    site: query for this hostname returned nothing when SHAN-520 shipped, so
 *    there was no existing result for a blanket Disallow to strand.
 *  - This header is what covers a crawler that ignores robots.txt, and — the
 *    part that only works this way — it rides the shanejli.com rewrite onto
 *    the proxied /api/* responses, putting a noindex on the canonical domain's
 *    copy of the API without blocking anything Googlebot fetches while
 *    rendering a page.
 *
 * If this origin ever does turn up in an index, the recovery is to drop the
 * Disallow temporarily so the noindex below becomes visible to the crawler,
 * then restore it once the URLs have aged out.
 */
export const ROBOTS_TAG = "noindex, nofollow";

/**
 * Stamps `X-Robots-Tag` on whatever response the app ends up returning.
 *
 * Registered FIRST in src/app.ts, which is what makes it unwind LAST — and
 * that is load-bearing, not stylistic. `conditionalGet` substitutes a brand
 * new `Response` for both the 200 and the 304 it builds, so a header set
 * before that middleware runs would be dropped on the way out. Setting it
 * after `next()` on the innermost-returning middleware means it lands on the
 * object that is actually served. tests/app-crawler-policy.test.ts asserts the
 * 304 case specifically, since that is the one a reorder would break quietly.
 */
export const crawlerPolicy = createMiddleware(async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", ROBOTS_TAG);
});
