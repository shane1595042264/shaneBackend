// SHAN-520: app-level wiring for the crawler policy. The origin used to 404 on
// /robots.txt, which crawlers read as "no restrictions", and no response
// carried an X-Robots-Tag.
//
// What this file guards is the part that only breaks in src/app.ts: that
// robots.txt is actually routed, and that the header survives onto the
// Response objects conditionalGet substitutes in. Middleware unwinds in
// reverse, so crawlerPolicy has to be registered BEFORE conditionalGet to run
// after it. Move that registration down and the 200 case still passes while
// the 304 case stops carrying the header — hence the test below.
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
  // /health embeds a fresh timestamp, so freeze the clock to keep its body —
  // and therefore its ETag — stable across the two requests in the 304 test.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SHAN-520: robots.txt", () => {
  it("serves a blanket disallow as text/plain", async () => {
    const res = await app.request("/robots.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("does not pick up an ETag", async () => {
    // conditionalGet only tags application/json. If that ever widens, a
    // robots.txt served with a validator is harmless but unintended, and this
    // is the cheapest place to notice.
    const res = await app.request("/robots.txt");

    expect(res.headers.get("ETag")).toBeNull();
  });
});

describe("SHAN-520: X-Robots-Tag", () => {
  it("stamps a 200 JSON route", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("stamps robots.txt itself", async () => {
    const res = await app.request("/robots.txt");

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("stamps a 404", async () => {
    // The fallthrough handler builds its own response; an unmatched path is
    // exactly the kind of URL a crawler would have found and indexed.
    const res = await app.request("/not-a-route");

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("survives onto the 304 that conditional GET substitutes in", async () => {
    // The regression guard for middleware ordering: conditionalGet discards the
    // original response's headers and returns a brand new Response for this
    // branch, so a header set before it runs would never reach the client.
    const etag = (await app.request("/health")).headers.get("ETag")!;
    expect(etag).toBeTruthy();

    const res = await app.request("/health", { headers: { "If-None-Match": etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("leaves the existing conditional-get and cors headers intact", async () => {
    const res = await app.request("/health", { headers: { Origin: "https://shanejli.com" } });

    expect(res.headers.get("ETag")).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });
});
