// SHAN-346: POST /api/rng/evaluate must not leak raw err.message from the
// URL-scrape (scrapeProductUrl) or LLM-classify (classifyProduct) failure
// paths. Both should return a safe, generic 400 with needs_manual:true so the
// frontend manual-entry fallback (lib/rng-api.ts) still triggers, while the
// real error is logged server-side. Mirrors the harness in
// rate-limit-routes.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const {
  mockGenerateText,
  mockClassifyProduct,
  mockScrapeProductUrl,
  mockGetCurrentBalance,
  mockGetLastMonthSpend,
  mockIsPlaidConfigured,
  mockSelect,
  mockInsert,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockClassifyProduct: vi.fn(),
  mockScrapeProductUrl: vi.fn(),
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
  createLinkToken: vi.fn(),
  exchangePublicToken: vi.fn(),
  getCurrentBalance: mockGetCurrentBalance,
  getLastMonthSpend: mockGetLastMonthSpend,
  isPlaidConfigured: mockIsPlaidConfigured,
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { rngRoutes } from "@/modules/rng-capitalist/routes";

const app = new Hono().route("/api/rng", rngRoutes);

const jwtHeaders = {
  "Content-Type": "application/json",
  "X-Test-User": "u-author",
};

const urlBody = JSON.stringify({
  url: "https://amazon.com/dp/B0CHX1W1XY",
  override_balance: 1000,
  override_last_month_spend: 100,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
  mockGetCurrentBalance.mockResolvedValue(1000);
  mockGetLastMonthSpend.mockResolvedValue(100);
  mockIsPlaidConfigured.mockReturnValue(true);
  // Ban list empty; decision insert returns a row (only reached on success).
  mockSelect.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
  mockInsert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: "decision-1" }]) }) });
});

describe("SHAN-346: /evaluate error sanitization", () => {
  it("scrapeProductUrl failure returns a safe 400 with needs_manual, no raw internals", async () => {
    mockScrapeProductUrl.mockRejectedValue(new Error("getaddrinfo ENOTFOUND internal.db.host secret-driver-detail"));

    const res = await app.request("/api/rng/evaluate", { method: "POST", headers: jwtHeaders, body: urlBody });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.needs_manual).toBe(true);
    expect(json.error).toBe("Could not fetch that URL. Please enter the product details manually.");
    expect(json.error).not.toContain("ENOTFOUND");
    expect(json.error).not.toContain("internal.db.host");
    expect(json.error).not.toContain("secret-driver-detail");
  });

  it("classifyProduct LLM-exhaustion failure returns a safe 400 with needs_manual, no provider internals", async () => {
    mockScrapeProductUrl.mockResolvedValue({ html: "<html></html>", ogImage: null });
    mockClassifyProduct.mockRejectedValue(
      new Error("All LLM providers failed. Anthropic: 401 invalid x-api-key sk-ant-secret; Groq: quota exceeded")
    );

    const res = await app.request("/api/rng/evaluate", { method: "POST", headers: jwtHeaders, body: urlBody });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.needs_manual).toBe(true);
    expect(json.error).toBe("Could not analyze that product automatically. Please enter the details manually.");
    expect(json.error).not.toContain("All LLM providers failed");
    expect(json.error).not.toContain("Anthropic");
    expect(json.error).not.toContain("sk-ant-secret");
  });
});
