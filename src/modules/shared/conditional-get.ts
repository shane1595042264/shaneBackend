import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";

/**
 * Conditional GET for JSON reads: attaches a validator to every 200 JSON GET
 * response and answers a matching `If-None-Match` with 304 and an empty body.
 *
 * Why: the read API is a documented public surface (see /docs and /llms.txt),
 * so agents poll it on a timer. Before this, an unchanged `GET
 * /api/journal/entries` re-transferred ~29KB (~7KB gzipped) on every poll
 * because no response carried a validator. Now the second poll costs a header
 * round-trip.
 *
 * The ETag is **weak** on purpose. Railway's edge proxy, not this server,
 * applies gzip, so the same handler output is served as two different
 * representations (identity and gzip). A strong ETag would be lying about
 * byte-for-byte equality across those; a weak one asserts only semantic
 * equivalence, which is exactly what we can promise. `If-None-Match` uses weak
 * comparison anyway, so 304s still work.
 */

/** Caches must revalidate, and must never share a body across users: responses
 * vary by `Authorization` but `Vary` does not list it (the header is set by the
 * cors middleware, which only knows about Origin). `private` closes that gap. */
const CACHE_CONTROL = "private, no-cache";

/** Headers a 304 must NOT carry: each one describes a representation the 304
 * has no body for (RFC 9110 15.4.5). Everything else is copied through, which
 * matters more than it looks: hono/cors sets its headers BEFORE calling the
 * next middleware, so by the time we run they are already on the response and
 * dropping them would make the 304 unreadable to a browser. */
const BODY_DESCRIBING_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-range",
  "transfer-encoding",
];

function computeEtag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** Strip the weak prefix and surrounding whitespace so `W/"abc"` and `"abc"`
 * compare equal — the weak comparison `If-None-Match` is defined to use. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}

function ifNoneMatchMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const target = normalizeTag(etag);
  return header.split(",").some((tag) => normalizeTag(tag) === target);
}

export const conditionalGet = createMiddleware(async (c, next) => {
  await next();

  // GET only. Hono does not route HEAD to GET handlers, and if it ever did the
  // body would already be stripped here, which would hash to a tag that
  // disagrees with the GET one for the same resource.
  if (c.req.method !== "GET") return;

  const res = c.res;
  if (res.status !== 200) return;
  // A handler that already picked its own validator (or its own caching policy,
  // like the immutable image routes) knows better than this middleware.
  if (res.headers.has("ETag")) return;
  if (!(res.headers.get("Content-Type") ?? "").includes("application/json")) return;

  // c.json() bodies are already fully buffered strings, so reading them back is
  // cheap. Reading consumes the body, hence the rebuilt Response below.
  const body = await res.text();
  const etag = computeEtag(body);

  const headers = new Headers(res.headers);
  headers.set("ETag", etag);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", CACHE_CONTROL);

  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifNoneMatch && ifNoneMatchMatches(ifNoneMatch, etag)) {
    const notModified = new Headers(headers);
    for (const name of BODY_DESCRIBING_HEADERS) notModified.delete(name);
    // Assigning c.res copies the OLD response's headers onto the new one (Hono's
    // res setter), which would drag the body-describing headers we just removed
    // straight back onto a bodiless 304. notModified already carries everything
    // worth keeping, so clear the old set first.
    for (const name of [...res.headers.keys()]) res.headers.delete(name);
    c.res = new Response(null, { status: 304, headers: notModified });
    return;
  }

  c.res = new Response(body, { status: 200, headers });
});
