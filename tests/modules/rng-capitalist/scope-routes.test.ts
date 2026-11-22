// SHAN-732: every /api/rng route behind requireAuth alone let any PAT in,
// whatever its scopes, so a reactions-only token could read the owner's live
// bank balance (/budget), every past price and balance (/history), the ban
// list, and run evaluate, which writes the ledger and can ban a category for
// 30 days. They now take entries:write on a PAT, like tea entries and
// skincare. requireScope is the real one here; only requireAuth is stubbed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const {
  mockGenerateText,
  mockGetCurrentBalance,
  mockGetLastMonthSpend,
  mockCreateLinkToken,
  mockSelect,
  mockInsert,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetCurrentBalance: vi.fn(),
  mockGetLastMonthSpend: vi.fn(),
  mockCreateLinkToken: vi.fn(),
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

vi.mock("@/modules/shared/llm", () => ({ generateText: mockGenerateText }));
vi.mock("@/modules/rng-capitalist/classifier", () => ({ classifyProduct: vi.fn() }));
vi.mock("@/modules/rng-capitalist/scraper", () => ({ scrapeProductUrl: vi.fn() }));
vi.mock("@/modules/rng-capitalist/plaid", () => ({
  createLinkToken: mockCreateLinkToken,
  exchangePublicToken: vi.fn(),
  getCurrentBalance: mockGetCurrentBalance,
  getLastMonthSpend: mockGetLastMonthSpend,
  isPlaidConfigured: () => true,
}));

// X-Test-Scopes turns the request into a PAT holding those comma-separated
// scopes; without it the request is a browser JWT (tokenScopes null).
vi.mock("@/modules/auth/middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/middleware")>()),
  requireAuth: async (c: any, next: any) => {
    c.set("userId", "u-owner");
    const scopes = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", scopes === undefined ? null : scopes.split(",").filter(Boolean));
    c.set("tokenId", scopes === undefined ? null : "pat-test");
    await next();
  },
}));

import { rngRoutes } from "@/modules/rng-capitalist/routes";

const app = new Hono().route("/api/rng", rngRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
  mockGenerateText.mockResolvedValue({
    text: '{"generic_category":"test","is_entertainment":true}',
    modelUsed: "test-model",
    usage: {},
  });
  mockGetCurrentBalance.mockResolvedValue(1000);
  mockGetLastMonthSpend.mockResolvedValue(100);
  // Covers the ban lookup (.where().then), /bans (.where().orderBy) and
  // /history (.where().orderBy().limit).
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => {
        const rows = Promise.resolve([]);
        return Object.assign(rows, {
          orderBy: () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([]) }),
        });
      },
    }),
  });
  mockInsert.mockReturnValue({
    values: () => ({ returning: () => Promise.resolve([{ id: "decision-1" }]) }),
  });
});

const evaluateBody = JSON.stringify({
  product_name: "Test Product",
  price: 25,
  override_balance: 1000,
  override_last_month_spend: 100,
});

const routes: Array<[string, string, RequestInit]> = [
  ["GET", "/api/rng/budget", {}],
  ["GET", "/api/rng/history", {}],
  ["GET", "/api/rng/bans", {}],
  ["POST", "/api/rng/evaluate", { body: evaluateBody }],
];

function call(method: string, path: string, init: RequestInit, scopes?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (scopes !== undefined) headers["X-Test-Scopes"] = scopes;
  return app.request(path, { method, headers, ...init });
}

describe("rng-capitalist PAT scope (SHAN-732)", () => {
  it.each(routes)("%s %s 403s a reactions-only PAT", async (method, path, init) => {
    const res = await call(method, path, init, "reactions:write");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Token missing required scope: entries:write" });
  });

  it("a reactions-only PAT never reaches Plaid, the LLM or the ledger", async () => {
    for (const [method, path, init] of routes) await call(method, path, init, "reactions:write");
    expect(mockGetCurrentBalance).not.toHaveBeenCalled();
    expect(mockGetLastMonthSpend).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each(routes)("%s %s lets an entries:write PAT through", async (method, path, init) => {
    const res = await call(method, path, init, "reactions:write,entries:write");
    expect(res.status).toBe(200);
  });

  it.each(routes)("%s %s lets a browser session through", async (method, path, init) => {
    const res = await call(method, path, init);
    expect(res.status).toBe(200);
  });

  it("bank linking still answers the browser-session error to a PAT, even one with entries:write", async () => {
    const res = await call("POST", "/api/rng/plaid/link-token", {}, "entries:write");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Bank linking requires a browser session, not a PAT" });
    expect(mockCreateLinkToken).not.toHaveBeenCalled();
  });
});
