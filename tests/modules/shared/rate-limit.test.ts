import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createPATRateLimit,
  __resetRateLimitBuckets,
} from "@/modules/shared/rate-limit";

beforeEach(() => {
  __resetRateLimitBuckets();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function buildApp(opts: { limitPerMinute: number; bucket: string }) {
  const app = new Hono<{ Variables: { tokenId: string | null } }>();
  app.use("*", async (c, next) => {
    c.set("tokenId", c.req.header("X-Test-Token") ?? null);
    await next();
  });
  app.use("*", createPATRateLimit(opts));
  app.get("/ping", (c) => c.text("ok"));
  return app;
}

describe("createPATRateLimit", () => {
  it("allows requests with no tokenId (JWT/anon) through without counting", async () => {
    const app = buildApp({ limitPerMinute: 2, bucket: "jwt-bypass" });
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/ping");
      expect(res.status).toBe(200);
    }
  });

  it("counts PAT requests and 429s once limit is exceeded", async () => {
    const app = buildApp({ limitPerMinute: 2, bucket: "pat-limit" });
    const headers = { "X-Test-Token": "pat-abc" };
    const r1 = await app.request("/ping", { headers });
    const r2 = await app.request("/ping", { headers });
    const r3 = await app.request("/ping", { headers });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBe("60");
  });

  it("isolates buckets so single + batch don't share counters", async () => {
    const single = buildApp({ limitPerMinute: 1, bucket: "single-bucket" });
    const batch = buildApp({ limitPerMinute: 1, bucket: "batch-bucket" });
    const headers = { "X-Test-Token": "pat-xyz" };
    expect((await single.request("/ping", { headers })).status).toBe(200);
    expect((await batch.request("/ping", { headers })).status).toBe(200);
    expect((await single.request("/ping", { headers })).status).toBe(429);
    expect((await batch.request("/ping", { headers })).status).toBe(429);
  });

  it("isolates buckets per tokenId so one client doesn't lock out another", async () => {
    const app = buildApp({ limitPerMinute: 1, bucket: "per-token" });
    const a = { "X-Test-Token": "pat-alpha" };
    const b = { "X-Test-Token": "pat-beta" };
    expect((await app.request("/ping", { headers: a })).status).toBe(200);
    expect((await app.request("/ping", { headers: b })).status).toBe(200);
    expect((await app.request("/ping", { headers: a })).status).toBe(429);
    expect((await app.request("/ping", { headers: b })).status).toBe(429);
  });

  it("resets counters after the 60-second window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T17:00:00Z"));
    const app = buildApp({ limitPerMinute: 1, bucket: "window-test" });
    const headers = { "X-Test-Token": "pat-time" };
    expect((await app.request("/ping", { headers })).status).toBe(200);
    expect((await app.request("/ping", { headers })).status).toBe(429);
    vi.setSystemTime(new Date("2026-05-16T17:01:01Z"));
    expect((await app.request("/ping", { headers })).status).toBe(200);
  });
});
