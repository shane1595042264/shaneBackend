import { createMiddleware } from "hono/factory";

type BucketState = Map<string, { count: number; windowStart: number }>;
const buckets = new Map<string, BucketState>();

const WINDOW_MS = 60_000;

interface Options {
  limitPerMinute: number;
  bucket: string;
}

export function createPATRateLimit(opts: Options) {
  if (!buckets.has(opts.bucket)) buckets.set(opts.bucket, new Map());
  const bucket = buckets.get(opts.bucket)!;

  return createMiddleware<{ Variables: { tokenId: string | null } }>(
    async (c, next) => {
      const tokenId = c.get("tokenId");
      if (!tokenId) {
        // JWT or anonymous — no PAT, no per-token limit.
        await next();
        return;
      }

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

/** Test-only helper to clear all rate-limit buckets between tests. */
export function __resetRateLimitBuckets() {
  buckets.clear();
}
