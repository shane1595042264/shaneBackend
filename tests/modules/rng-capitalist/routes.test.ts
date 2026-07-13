import { describe, it, expect } from "vitest";
import { evaluateSchema, historyQuerySchema } from "@/modules/rng-capitalist/routes";

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
