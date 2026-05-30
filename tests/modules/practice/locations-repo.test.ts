import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockUpsert, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => mockSelect() }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: () => mockUpsert() }),
      }),
    }),
    delete: () => ({
      where: () => ({ returning: () => mockDelete() }),
    }),
  },
}));

import { listLocations, upsertLocation, deleteLocation, normalizeLocationName } from "@/modules/practice/locations-repo";

beforeEach(() => vi.clearAllMocks());

describe("normalizeLocationName", () => {
  it("lowercases and trims", () => {
    expect(normalizeLocationName("  Studio  ")).toBe("studio");
  });
  it("collapses internal whitespace", () => {
    expect(normalizeLocationName("Coffee  Shop")).toBe("coffee shop");
  });
  it("preserves diacritics (no NFD fold by design — Café and Cafe are different places)", () => {
    expect(normalizeLocationName("Café")).toBe("café");
  });
});

describe("listLocations", () => {
  it("returns rows sorted by recency (DB does the sort)", async () => {
    mockSelect.mockResolvedValue([
      { id: "l1", name: "Studio", normalized: "studio", lastUsedAt: new Date("2026-05-20") },
      { id: "l2", name: "Park", normalized: "park", lastUsedAt: new Date("2026-05-15") },
    ]);
    const got = await listLocations("u1");
    expect(got).toHaveLength(2);
    expect(got[0].name).toBe("Studio");
  });
});

describe("upsertLocation", () => {
  it("inserts when missing", async () => {
    mockUpsert.mockResolvedValue([{ id: "l1", name: "Studio", normalized: "studio" }]);
    const got = await upsertLocation("u1", "Studio");
    expect(got!.normalized).toBe("studio");
  });

  it("returns null when name is blank after normalization", async () => {
    expect(await upsertLocation("u1", "   ")).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("deleteLocation", () => {
  it("returns true on success", async () => {
    mockDelete.mockResolvedValue([{ id: "l1" }]);
    expect(await deleteLocation("l1", "u1")).toBe(true);
  });

  it("returns false when not owner / not found", async () => {
    mockDelete.mockResolvedValue([]);
    expect(await deleteLocation("l1", "u1")).toBe(false);
  });
});
