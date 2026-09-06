// SHAN-455: app-level wiring for conditional GET. The middleware itself is unit
// tested in tests/modules/shared/conditional-get.test.ts; what this file guards
// is the part that only breaks in src/app.ts — registration order relative to
// cors, and the two CORS header lists that make ETag usable from a browser.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetPool } = vi.hoisted(() => ({ mockGetPool: vi.fn() }));

// Full mock of the db client so importing the whole app never touches a real DB.
vi.mock("@/db/client", () => ({
  getPool: (...args: any[]) => mockGetPool(...args),
  getDb: () => ({}),
  pool: { get: (...args: any[]) => mockGetPool(...args) },
  db: {},
}));
vi.mock("@/cron/ingest", () => ({ ingestActivities: vi.fn() }));
vi.mock("@/modules/shared/llm", () => ({ generateText: vi.fn() }));

const { default: app } = await import("@/app");

beforeEach(() => {
  mockGetPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) });
  // /health embeds a fresh timestamp, so freeze the clock to make its body —
  // and therefore its ETag — stable across the two requests below.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SHAN-455: conditional GET is wired into the app", () => {
  it("tags a real 200 JSON route and 304s a repeat request", async () => {
    const first = await app.request("/health");
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const second = await app.request("/health", { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("keeps the cors headers on the substituted 304", async () => {
    const etag = (await app.request("/health", { headers: { Origin: "https://shanejli.com" } }))
      .headers.get("ETag")!;

    const res = await app.request("/health", {
      headers: { Origin: "https://shanejli.com", "If-None-Match": etag },
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  });

  it("allows If-None-Match through the CORS preflight and exposes ETag", async () => {
    const res = await app.request("/api/journal/entries", {
      method: "OPTIONS",
      headers: {
        Origin: "https://shanejli.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "If-None-Match",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  });
});
