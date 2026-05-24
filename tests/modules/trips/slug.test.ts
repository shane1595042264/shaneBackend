import { describe, it, expect, vi } from "vitest";
import { slugifyTitle, generateUniqueSlug } from "@/modules/trips/slug";

describe("slugifyTitle", () => {
  it("kebab-cases a normal title", () => {
    expect(slugifyTitle("Tokyo 2026 — June Trip")).toBe("tokyo-2026-june-trip");
  });

  it("strips diacritics", () => {
    expect(slugifyTitle("São Paulo Café")).toBe("sao-paulo-cafe");
  });

  it("collapses multiple separators", () => {
    expect(slugifyTitle("a---b__c   d")).toBe("a-b-c-d");
  });

  it("caps at 60 chars", () => {
    expect(slugifyTitle("a".repeat(200)).length).toBe(60);
  });

  it("returns empty string for a non-alphanumeric title", () => {
    expect(slugifyTitle("!!! ---")).toBe("");
  });
});

describe("generateUniqueSlug", () => {
  it("returns the base slug when it's free", async () => {
    const slug = await generateUniqueSlug("Tokyo Trip", async () => false);
    expect(slug).toBe("tokyo-trip");
  });

  it("appends a random suffix on collision", async () => {
    let calls = 0;
    const slug = await generateUniqueSlug("Tokyo Trip", async () => {
      calls++;
      return calls === 1; // first check (base) collides, suffix is free
    });
    expect(slug).toMatch(/^tokyo-trip-[a-z0-9]{4}$/);
  });

  it("falls back to pure random when title is empty", async () => {
    const slug = await generateUniqueSlug(null, async () => false);
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
  });

  it("falls back to long random after 5 colliding attempts", async () => {
    const taken = vi.fn(async () => true);
    const slug = await generateUniqueSlug("Tokyo Trip", taken);
    // 1 base + 5 suffix probes = 6 calls; then fallback
    expect(taken).toHaveBeenCalledTimes(6);
    expect(slug.length).toBeGreaterThanOrEqual(8);
  });
});
