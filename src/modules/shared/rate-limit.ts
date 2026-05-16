import { createMiddleware } from "hono/factory";

type BucketState = Map<string, { count: number; windowStart: number }>;
const buckets = new Map<string, BucketState>();

const WINDOW_MS = 60_000;

interface Options {
  limitPerMinute: number;
  bucket: string;
}

export function createPATRateLimit(opts: Options) {
  return createMiddleware<{ Variables: { tokenId: string | null } }>(
    async (c, next) => {
      const tokenId = c.get("tokenId");
      if (!tokenId) {
        // JWT or anonymous — no PAT, no per-token limit.
        await next();
        return;
      }

      // Look up the bucket per request, not at factory time. If __resetRateLimitBuckets
      // ran (test isolation), the outer Map's inner Maps were cleared in place — but
      // accessing through the outer Map each call also lets a freshly-created bucket
      // take effect for in-flight requests.
      if (!buckets.has(opts.bucket)) buckets.set(opts.bucket, new Map());
      const bucket = buckets.get(opts.bucket)!;

      const now = Date.now();
      const entry = bucket.get(tokenId);
      if (!entry || now - entry.windowStart >= WINDOW_MS) {
        bucket.set(tokenId, { count: 1, windowStart: now });
        await next();
        return;
      }

      if (entry.count >= opts.limitPerMinute) {
        return c.json(
          { error: "Rate limit exceeded. Try again in 60 seconds." },
          429,
          { "Retry-After": "60" }
        );
      }

      entry.count += 1;
      await next();
    }
  );
}

/** Test-only helper to clear all rate-limit state between tests. Empties each inner
 * bucket in place so any factory closure still pointing at one sees the cleared map. */
export function __resetRateLimitBuckets() {
  for (const inner of buckets.values()) inner.clear();
  buckets.clear();
}
