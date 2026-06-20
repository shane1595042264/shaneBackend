// Per-PAT rate limits on the rng-capitalist write surface. evaluate fires the
// LLM on every request (manual-input path → generateText, URL-scrape path →
// classifyProduct), so it has its own tight bucket. The plaid bucket covers
// every endpoint that hits Plaid's API — plaid/link-token + plaid/exchange
// (setup) and /budget (read-on-render). JWTs (no tokenId) bypass.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const {
  mockGenerateText,
  mockClassifyProduct,
  mockScrapeProductUrl,
  mockCreateLinkToken,
  mockExchangePublicToken,
  mockGetCurrentBalance,
  mockGetLastMonthSpend,
  mockIsPlaidConfigured,
  mockSelect,
  mockInsert,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockClassifyProduct: vi.fn(),
  mockScrapeProductUrl: vi.fn(),
  mockCreateLinkToken: vi.fn(),
  mockExchangePublicToken: vi.fn(),
  mockGetCurrentBalance: vi.fn(),
  mockGetLastMonthSpend: vi.fn(),
  mockIsPlaidConfigured: vi.fn(),
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

vi.mock("@/modules/shared/llm", () => ({
  generateText: mockGenerateText,
}));

vi.mock("@/modules/rng-capitalist/classifier", () => ({
  classifyProduct: mockClassifyProduct,
}));

vi.mock("@/modules/rng-capitalist/scraper", () => ({
  scrapeProductUrl: mockScrapeProductUrl,
}));

vi.mock("@/modules/rng-capitalist/plaid", () => ({
  createLinkToken: mockCreateLinkToken,
  exchangePublicToken: mockExchangePublicToken,
  getCurrentBalance: mockGetCurrentBalance,
  getLastMonthSpend: mockGetLastMonthSpend,
  isPlaidConfigured: mockIsPlaidConfigured,
}));

// Same auth shape as journal/rate-limit-routes.test.ts: X-Test-Token flips the
// request from JWT to PAT by setting tokenId. The limiter only counts when
// tokenId is non-null.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { rngRoutes } from "@/modules/rng-capitalist/routes";

const app = new Hono().route("/api/rng", rngRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();

  // Manual-input evaluate path: generateText classifies, db.insert(rngDecisions)
  // returns one row, ban list is empty.
  mockGenerateText.mockResolvedValue({
    text: '{"generic_category":"test","is_entertainment":true}',
    modelUsed: "test-model",
    usage: {},
  });
  // db.select().from(rngBanList).where(...).then((bans) => bans.find(...))
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => Promise.resolve([]),
    }),
  });
  // db.insert(rngDecisions).values(...).returning() → [{id, ...}]
  // db.insert(rngBanList).values(...) → undefined (no .returning() call)
  mockInsert.mockReturnValue({
    values: () => ({
      returning: () => Promise.resolve([{ id: "decision-1" }]),
    }),
  });

  mockIsPlaidConfigured.mockReturnValue(true);
  mockCreateLinkToken.mockResolvedValue("link_token_test");
  mockExchangePublicToken.mockResolvedValue(undefined);
});

function patHeaders(token = "pat-test") {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "u-author",
    "X-Test-Token": token,
  };
}
function jwtHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "u-author",
  };
}

const evaluateBody = JSON.stringify({
  product_name: "Test Product",
  price: 25,
  override_balance: 1000,
  override_last_month_spend: 100,
});

describe("rng-capitalist write rate limits (per PAT)", () => {
  it("evaluate bucket 429s a PAT after 10 POSTs in a minute", async () => {
    const headers = patHeaders();
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/rng/evaluate", {
        method: "POST",
        headers,
        body: evaluateBody,
      });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/api/rng/evaluate", {
      method: "POST",
      headers,
      body: evaluateBody,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("JWT requests with no tokenId bypass the evaluate limiter", async () => {
    const headers = jwtHeaders();
    for (let i = 0; i < 15; i++) {
      const res = await app.request("/api/rng/evaluate", {
        method: "POST",
        headers,
        body: evaluateBody,
      });
      expect(res.status).toBe(200);
    }
  });

  it("isolates evaluate bucket per PAT id so one client doesn't lock out another", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/rng/evaluate", {
        method: "POST",
        headers: patHeaders("pat-alpha"),
        body: evaluateBody,
      });
      expect(r.status).toBe(200);
    }
    const alphaBlocked = await app.request("/api/rng/evaluate", {
      method: "POST",
      headers: patHeaders("pat-alpha"),
      body: evaluateBody,
    });
    expect(alphaBlocked.status).toBe(429);

    const beta = await app.request("/api/rng/evaluate", {
      method: "POST",
      headers: patHeaders("pat-beta"),
      body: evaluateBody,
    });
    expect(beta.status).toBe(200);
  });

  it("evaluate bucket is independent from plaid bucket", async () => {
    const headers = patHeaders();
    // Burn the evaluate bucket.
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/rng/evaluate", {
        method: "POST",
        headers,
        body: evaluateBody,
      });
      expect(r.status).toBe(200);
    }
    const evaluateBlocked = await app.request("/api/rng/evaluate", {
      method: "POST",
      headers,
      body: evaluateBody,
    });
    expect(evaluateBlocked.status).toBe(429);

    // plaid/link-token still goes through — separate bucket.
    const link = await app.request("/api/rng/plaid/link-token", {
      method: "POST",
      headers,
    });
    expect(link.status).toBe(200);
  });

  it("plaid/link-token and plaid/exchange share one bucket (combined counter)", async () => {
    const headers = patHeaders();
    // Mix link-token + exchange calls to hit 10 total.
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/api/rng/plaid/link-token", {
        method: "POST",
        headers,
      });
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/api/rng/plaid/exchange", {
        method: "POST",
        headers,
        body: JSON.stringify({ public_token: "ptok-xyz" }),
      });
      expect(r.status).toBe(200);
    }
    // 11th plaid call — either endpoint — is 429.
    const blocked = await app.request("/api/rng/plaid/exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({ public_token: "ptok-xyz" }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("budget joins the plaid bucket — 429s a PAT after 10 GETs in a minute", async () => {
    const headers = patHeaders();
    mockGetCurrentBalance.mockResolvedValue(1000);
    mockGetLastMonthSpend.mockResolvedValue(100);
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/rng/budget", { headers });
      expect(r.status).toBe(200);
    }
    const blocked = await app.request("/api/rng/budget", { headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("JWT requests with no tokenId bypass the budget limiter", async () => {
    const headers = jwtHeaders();
    mockGetCurrentBalance.mockResolvedValue(1000);
    mockGetLastMonthSpend.mockResolvedValue(100);
    for (let i = 0; i < 15; i++) {
      const r = await app.request("/api/rng/budget", { headers });
      expect(r.status).toBe(200);
    }
  });

  it("budget shares the plaid bucket with link-token + exchange (combined counter across all three)", async () => {
    const headers = patHeaders();
    mockGetCurrentBalance.mockResolvedValue(1000);
    mockGetLastMonthSpend.mockResolvedValue(100);
    // Mix all three plaid-bucket endpoints to hit 10 total.
    for (let i = 0; i < 4; i++) {
      const r = await app.request("/api/rng/budget", { headers });
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const r = await app.request("/api/rng/plaid/link-token", { method: "POST", headers });
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const r = await app.request("/api/rng/plaid/exchange", {
        method: "POST",
        headers,
        body: JSON.stringify({ public_token: "ptok-xyz" }),
      });
      expect(r.status).toBe(200);
    }
    // 11th plaid-bucket call — budget — is 429.
    const blocked = await app.request("/api/rng/budget", { headers });
    expect(blocked.status).toBe(429);
  });
});
