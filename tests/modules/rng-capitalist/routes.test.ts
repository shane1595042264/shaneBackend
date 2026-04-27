import { describe, it, expect } from "vitest";
import { evaluateSchema } from "@/modules/rng-capitalist/routes";

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
