import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

/**
 * Rejects any request carrying a NUL byte with a 400 (SHAN-553).
 *
 * Postgres `text` and `jsonb` cannot store the 0x00 byte. A NUL that reaches a
 * query makes the driver throw `invalid byte sequence for encoding "UTF8":
 * 0x00`, and `errorHandler` reports that as a 500. Found on prod in a debug
 * probe: `GET /api/blog/posts?q=%00`, `?tag=%00` and `/api/courses/%00` all
 * answered 500 to an unauthenticated caller, while the routes whose zod schema
 * happened to regex-check the value (blog slug, trip slug) already said 400.
 * That was luck, not policy, and every JSON write body had the same hole.
 *
 * Checked here once rather than in each schema so a new route cannot forget.
 * The response is the same `{ error, details }` envelope `zod-validator.ts`
 * produces, so clients handle it like any other validation failure.
 */

/** A NUL can only reach the URL percent-encoded; HTTP forbids the raw byte. */
const ENCODED_NUL = /%00/i;

/**
 * Dot-joined path of the first string or key holding a NUL, `""` for the
 * root value, or `null` when the value is clean. Same path format as
 * `formatValidationIssues`, so a client can key a form field off it.
 */
export function findNul(value: unknown, path: string[] = []): string | null {
  if (typeof value === "string") return value.includes("\0") ? path.join(".") : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNul(value[i], [...path, String(i)]);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.includes("\0")) return [...path, key.replace(/\0/g, "\\u0000")].join(".");
      const hit = findNul(child, [...path, key]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function reject(c: Context, path?: string) {
  const message = "Contains a NUL byte, which cannot be stored";
  const detail = path ? { path, message } : { message };
  return c.json(
    { error: `Validation failed: ${path ? `${path}: ` : ""}${message}`, details: [detail] },
    400
  );
}

export const rejectNul = createMiddleware(async (c, next) => {
  if (ENCODED_NUL.test(c.req.url)) return reject(c, "url");

  // JSON only. The body is read through `c.req.text()` so Hono's body cache
  // hands the same bytes to the handler's `c.req.json()`. Multipart bodies are
  // never touched: once `text` is cached, Hono rebuilds `formData()` from it
  // without the Content-Type boundary and the upload fails to parse.
  const contentType = c.req.header("Content-Type") ?? "";
  if (/^application\/(.+\+)?json\b/i.test(contentType)) {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      // Malformed or empty JSON is the route validator's call, not ours.
      return next();
    }
    const hit = findNul(body);
    if (hit !== null) return reject(c, hit || undefined);
  }

  return next();
});
