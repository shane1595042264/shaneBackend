import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    execute: (..._args: unknown[]) => mockExecute(),
  },
}));

import { generateSessionItems } from "@/modules/practice/generator";

beforeEach(() => vi.clearAllMocks());

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
});
