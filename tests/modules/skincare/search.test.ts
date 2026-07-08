import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchProducts, __resetSearchCache } from "@/modules/skincare/search";

function mockFetchOnce(products: unknown[], ok = true) {
  return vi.fn().mockResolvedValueOnce({
    ok,
    json: async () => ({ products }),
  });
}

const originalFetch = globalThis.fetch;

describe("skincare searchProducts", () => {
  beforeEach(() => {
    __resetSearchCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns [] for queries shorter than 2 chars without calling upstream", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await searchProducts("a")).toEqual([]);
    expect(await searchProducts("  ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps OBF rows to {name, brand, imageUrl}, keeping the first brand", async () => {
    globalThis.fetch = mockFetchOnce([
      {
        product_name: "Moisturising Cream",
        brands: "CeraVe, L'Oréal",
        image_front_small_url: "https://img/cerave.jpg",
      },
    ]) as unknown as typeof fetch;
    const results = await searchProducts("cerave");
    expect(results).toEqual([
      { name: "Moisturising Cream", brand: "CeraVe", imageUrl: "https://img/cerave.jpg" },
    ]);
  });

  it("drops rows with no product_name and falls back to image_front_url", async () => {
    globalThis.fetch = mockFetchOnce([
      { product_name: "", brands: "X", image_front_small_url: "https://img/x.jpg" },
      { product_name: "Cleanser", brands: null, image_front_url: "https://img/full.jpg" },
    ]) as unknown as typeof fetch;
    const results = await searchProducts("cleanser");
    expect(results).toEqual([
      { name: "Cleanser", brand: null, imageUrl: "https://img/full.jpg" },
    ]);
  });

  it("dedupes near-identical rows by name+brand", async () => {
    globalThis.fetch = mockFetchOnce([
      { product_name: "Foaming Gel", brands: "CeraVe", image_front_small_url: "https://img/a.jpg" },
      { product_name: "foaming gel", brands: "cerave", image_front_small_url: "https://img/b.jpg" },
      { product_name: "Foaming Gel", brands: "Other", image_front_small_url: "https://img/c.jpg" },
    ]) as unknown as typeof fetch;
    const results = await searchProducts("foaming");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ name: "Foaming Gel", brand: "CeraVe", imageUrl: "https://img/a.jpg" });
    expect(results[1].brand).toBe("Other");
  });

  it("returns [] when upstream is not ok", async () => {
    globalThis.fetch = mockFetchOnce([], false) as unknown as typeof fetch;
    expect(await searchProducts("cerave")).toEqual([]);
  });

  it("returns [] when fetch rejects (timeout/network)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("aborted")) as unknown as typeof fetch;
    expect(await searchProducts("cerave")).toEqual([]);
  });

  it("caches non-empty results so a repeated query hits upstream once", async () => {
    const fetchMock = mockFetchOnce([
      { product_name: "Serum", brands: "The Ordinary", image_front_small_url: "https://img/s.jpg" },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = await searchProducts("serum");
    const second = await searchProducts("SERUM"); // normalized to same key
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ products: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          products: [{ product_name: "Toner", brands: "Anua", image_front_small_url: "https://img/t.jpg" }],
        }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await searchProducts("toner")).toEqual([]);
    const second = await searchProducts("toner");
    expect(second).toEqual([{ name: "Toner", brand: "Anua", imageUrl: "https://img/t.jpg" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
