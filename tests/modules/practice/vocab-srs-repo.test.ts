import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectLimit, mockInsertValues, mockUpsert, mockUpdate, mockGetSettings } = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetSettings: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockSelectLimit() }) }) }),
    insert: () => ({
      values: () => {
        // vocabReviews insert is awaited directly; vocabSrs insert chains .onConflictDoUpdate.
        const p = Promise.resolve(mockInsertValues()) as Promise<unknown> & {
          onConflictDoUpdate?: () => Promise<unknown>;
        };
        p.onConflictDoUpdate = () => mockUpsert();
        return p;
      },
    }),
    update: () => ({ set: () => ({ where: () => mockUpdate() }) }),
  },
}));

vi.mock("@/modules/practice/settings-repo", () => ({
  getSettings: (...a: unknown[]) => mockGetSettings(...a),
}));

import { applyReview } from "@/modules/practice/vocab-srs-repo";

const NOW = new Date("2026-07-24T12:00:00Z");
const baseInput = {
  userId: "u1",
  sessionId: "s1",
  itemId: "w1",
  locationId: "loc1",
  locationName: "Home",
  locationNormalized: "home",
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({
    vocabIntervalL1Days: 1,
    vocabIntervalL2Days: 3,
    vocabLapseIntervalDays: 1,
    vocabLevelToMemorize: 3,
  });
  mockInsertValues.mockResolvedValue(undefined);
  mockUpsert.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue(undefined);
});

describe("applyReview", () => {
  it("new word + remember → level 1, not memorized, no card write", async () => {
    mockSelectLimit.mockResolvedValueOnce([]); // no existing SRS row
    const res = await applyReview({ ...baseInput, grade: "remember" });
    expect(res.level).toBe(1);
    expect(res.memorized).toBe(false);
    expect(res.longTermMemorized).toBe(false);
    expect(mockUpsert).toHaveBeenCalledTimes(1); // SRS upsert
    expect(mockUpdate).not.toHaveBeenCalled(); // card memorization NOT written
  });

  it("level 2 + remember → memorized, writes memorization location to the card", async () => {
    mockSelectLimit
      .mockResolvedValueOnce([{ level: 2, dueAt: NOW, memorizedAt: null, reps: 4, lapses: 1 }]) // existing SRS
      .mockResolvedValueOnce([{ locations: [] }]); // card memorizationLocations
    const res = await applyReview({ ...baseInput, grade: "remember" });
    expect(res.level).toBe(3);
    expect(res.memorized).toBe(true);
    expect(res.longTermMemorized).toBe(false); // only 1 location so far
    expect(mockUpdate).toHaveBeenCalledTimes(1); // card write happened
  });

  it("level 2 + remember when card already at 6 locations → long-term memorized flips", async () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    mockSelectLimit
      .mockResolvedValueOnce([{ level: 2, dueAt: NOW, memorizedAt: null, reps: 4, lapses: 0 }])
      .mockResolvedValueOnce([{ locations: six }]);
    const res = await applyReview({ ...baseInput, grade: "remember" });
    expect(res.memorized).toBe(true);
    expect(res.longTermMemorized).toBe(true); // 6 + Home = 7
  });

  it("forget → not memorized, no card write", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ level: 2, dueAt: NOW, memorizedAt: null, reps: 3, lapses: 0 }]);
    const res = await applyReview({ ...baseInput, grade: "forget" });
    expect(res.level).toBe(1);
    expect(res.memorized).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
