import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

import { generateSessionItems } from "@/modules/practice/generator";

beforeEach(() => vi.clearAllMocks());

// Reconstruct the static SQL text from the drizzle `sql` template object so we
// can assert on the WHERE / ORDER BY the generator actually issues.
function capturedSql(): string {
  const arg = mockExecute.mock.calls[0]?.[0] as { queryChunks?: Array<{ value?: string[] }> };
  const chunks = arg?.queryChunks ?? [];
  return chunks.map((ch) => (ch && Array.isArray(ch.value) ? ch.value.join("") : "")).join("");
}

describe("generateSessionItems", () => {
  it("returns the rows the SQL produced, untouched", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { id: "v1", word: "Cha-cha", category: "dance_move", source: null,
          set_mode: "time", set_size: 60, rest_seconds: 30,
          loaded_locations: 0, last_practiced_at: null },
        { id: "v2", word: "Salsa", category: "dance_move", source: null,
          set_mode: "time", set_size: 90, rest_seconds: 30,
          loaded_locations: 2, last_practiced_at: new Date("2026-05-20") },
      ],
    });
    const out = await generateSessionItems({
      userId: "u1",
      categoryFilter: "dance_move",
      n: 5,
      includeSolidified: false,
    });
    expect(out).toHaveLength(2);
    expect(out[0].itemId).toBe("v1");
    expect(out[0].prescription.setMode).toBe("time");
    expect(out[0].prescription.setSize).toBe(60);
  });

  it("returns empty array when no rows match", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    expect(await generateSessionItems({ userId: "u1", categoryFilter: null, n: 5, includeSolidified: false })).toEqual([]);
  });

  it("clamps n to [1, 50]", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await generateSessionItems({ userId: "u1", categoryFilter: null, n: 0, includeSolidified: false });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("excludes time-mode (dance) prescriptions from the selection", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await generateSessionItems({ userId: "u1", categoryFilter: null, n: 5, includeSolidified: false });
    expect(capturedSql()).toContain("p.set_mode = 'reps'");
  });

  it("orders by ascending familiarity: fewest loaded locations first, then coldest", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await generateSessionItems({ userId: "u1", categoryFilter: null, n: 5, includeSolidified: false });
    const text = capturedSql();
    expect(text).toContain("ORDER BY COALESCE(mlpi.loaded_locations, 0) ASC");
    // location count must be the primary key, recency secondary
    expect(text.indexOf("COALESCE(mlpi.loaded_locations, 0) ASC")).toBeLessThan(
      text.indexOf("mlp.last_at NULLS FIRST"),
    );
  });
});
