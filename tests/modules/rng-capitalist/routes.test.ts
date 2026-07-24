import { describe, it, expect } from "vitest";
import { evaluateSchema, historyQuerySchema, exchangeSchema } from "@/modules/rng-capitalist/routes";

describe("evaluateSchema URL validation", () => {
  it("accepts a valid https URL", () => {
    const r = evaluateSchema.safeParse({ url: "https://amazon.com/dp/B0CHX1W1XY" });
    expect(r.success).toBe(true);
  });

  it("accepts a valid http URL", () => {
    const r = evaluateSchema.safeParse({ url: "http://example.com/product/123" });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed string", () => {
    const r = evaluateSchema.safeParse({ url: "not-a-url" });
    expect(r.success).toBe(false);
  });

  it("rejects javascript: scheme", () => {
    const r = evaluateSchema.safeParse({ url: "javascript:alert(1)" });
    expect(r.success).toBe(false);
  });

  it("rejects file: scheme", () => {
    const r = evaluateSchema.safeParse({ url: "file:///etc/passwd" });
    expect(r.success).toBe(false);
  });

  it("rejects data: scheme", () => {
    const r = evaluateSchema.safeParse({ url: "data:text/html,<script>alert(1)</script>" });
    expect(r.success).toBe(false);
  });

  it("rejects URLs longer than 2048 chars", () => {
    const huge = "https://example.com/" + "a".repeat(2050);
    const r = evaluateSchema.safeParse({ url: huge });
    expect(r.success).toBe(false);
  });
});

describe("evaluateSchema body shape", () => {
  it("accepts manual input (product_name + price, no URL)", () => {
    const r = evaluateSchema.safeParse({ product_name: "Steam Deck", price: 399 });
    expect(r.success).toBe(true);
  });

  it("rejects empty body (neither URL nor manual fields)", () => {
    const r = evaluateSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects product_name without price", () => {
    const r = evaluateSchema.safeParse({ product_name: "Steam Deck" });
    expect(r.success).toBe(false);
  });

  // SHAN-398: product_name persists to the unbounded rng_decisions.product_name
  // text column. Cap it at 500 chars so an oversized name can't be stored.
  it("rejects a product_name longer than 500 chars", () => {
    const r = evaluateSchema.safeParse({ product_name: "x".repeat(501), price: 10 });
    expect(r.success).toBe(false);
  });

  it("accepts a product_name at the 500-char boundary", () => {
    const r = evaluateSchema.safeParse({ product_name: "x".repeat(500), price: 10 });
    expect(r.success).toBe(true);
  });
});

// SHAN-423: price/override_balance/override_last_month_spend were bare
// z.number() (only NaN rejected). A JSON body {"price":1e309} parses to
// Infinity, passed zod, then .toFixed(2) = "Infinity" was persisted to the
// TEXT ledger columns — silent corruption. Bound them with .finite() + $1B cap.
describe("evaluateSchema numeric bounds (SHAN-423)", () => {
  const MONEY_MAX = 1_000_000_000;

  it("rejects an Infinity price (1e309 parses to Infinity in JS)", () => {
    const r = evaluateSchema.safeParse({ product_name: "Steam Deck", price: Infinity });
    expect(r.success).toBe(false);
  });

  it("rejects a price above the $1B cap", () => {
    const r = evaluateSchema.safeParse({ product_name: "Yacht", price: MONEY_MAX + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects a negative price", () => {
    const r = evaluateSchema.safeParse({ product_name: "Refund", price: -10 });
    expect(r.success).toBe(false);
  });

  it("accepts a price at the $1B boundary", () => {
    const r = evaluateSchema.safeParse({ product_name: "Yacht", price: MONEY_MAX });
    expect(r.success).toBe(true);
  });

  it("rejects an Infinity override_balance", () => {
    const r = evaluateSchema.safeParse({ product_name: "x", price: 10, override_balance: Infinity });
    expect(r.success).toBe(false);
  });

  it("accepts a negative override_balance (overdraft)", () => {
    const r = evaluateSchema.safeParse({ product_name: "x", price: 10, override_balance: -500 });
    expect(r.success).toBe(true);
  });

  it("rejects an override_balance beyond the ±$1B cap", () => {
    const r = evaluateSchema.safeParse({ product_name: "x", price: 10, override_balance: -(MONEY_MAX + 1) });
    expect(r.success).toBe(false);
  });

  it("rejects a negative override_last_month_spend", () => {
    const r = evaluateSchema.safeParse({ product_name: "x", price: 10, override_last_month_spend: -1 });
    expect(r.success).toBe(false);
  });

  it("rejects an override_last_month_spend above the $1B cap", () => {
    const r = evaluateSchema.safeParse({ product_name: "x", price: 10, override_last_month_spend: MONEY_MAX + 1 });
    expect(r.success).toBe(false);
  });
});

describe("exchangeSchema public_token bound (SHAN-414)", () => {
  it("accepts a normal Plaid public_token", () => {
    const r = exchangeSchema.safeParse({ public_token: "public-sandbox-abc123" });
    expect(r.success).toBe(true);
  });

  it("rejects a public_token longer than 500 chars", () => {
    const r = exchangeSchema.safeParse({ public_token: "x".repeat(501) });
    expect(r.success).toBe(false);
  });

  it("accepts a public_token at the 500-char boundary", () => {
    const r = exchangeSchema.safeParse({ public_token: "x".repeat(500) });
    expect(r.success).toBe(true);
  });
});

describe("historyQuerySchema pagination validation", () => {
  it("accepts an empty query (bare GET, legacy behavior)", () => {
    const r = historyQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBeUndefined();
      expect(r.data.cursor).toBeUndefined();
    }
  });

  it("coerces a numeric-string ?limit within range", () => {
    const r = historyQuerySchema.safeParse({ limit: "25" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(25);
  });

  it("rejects a non-numeric ?limit", () => {
    const r = historyQuerySchema.safeParse({ limit: "abc" });
    expect(r.success).toBe(false);
  });

  it("rejects ?limit below 1", () => {
    const r = historyQuerySchema.safeParse({ limit: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects ?limit above 100", () => {
    const r = historyQuerySchema.safeParse({ limit: "101" });
    expect(r.success).toBe(false);
  });

  it("rejects a fractional ?limit", () => {
    const r = historyQuerySchema.safeParse({ limit: "5.5" });
    expect(r.success).toBe(false);
  });

  it("accepts a valid ISO ?cursor", () => {
    const r = historyQuerySchema.safeParse({ cursor: "2026-07-13T14:00:00.000Z" });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed ?cursor", () => {
    const r = historyQuerySchema.safeParse({ cursor: "not-a-date" });
    expect(r.success).toBe(false);
  });

  it("rejects a date-only ?cursor (must be full ISO datetime)", () => {
    const r = historyQuerySchema.safeParse({ cursor: "2026-07-13" });
    expect(r.success).toBe(false);
  });
});
