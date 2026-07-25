import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsertReturning, mockSelectLimit, mockReviewRows, mockGenerate } = vi.hoisted(() => ({
  mockInsertReturning: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockReviewRows: vi.fn(),
  mockGenerate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    insert: () => ({ values: () => ({ returning: () => mockInsertReturning() }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockSelectLimit() }),
        // summary path: innerJoin(...).where(...).orderBy(...)
        innerJoin: () => ({ where: () => ({ orderBy: () => mockReviewRows() }) }),
      }),
    }),
  },
}));

vi.mock("@/modules/practice/vocab-generator", () => ({
  generateVocabSession: (...a: unknown[]) => mockGenerate(...a),
}));

import {
  createVocabSession,
  getVocabSession,
  vocabSessionSummary,
} from "@/modules/practice/vocab-sessions-repo";

const vocabSession = {
  id: "s1",
  userId: "u1",
  mode: "vocab",
  locationId: "loc1",
  locationName: "Home",
  locationNormalized: "home",
  nItemsRequested: 5,
};

beforeEach(() => vi.clearAllMocks());

describe("createVocabSession", () => {
  it("inserts a vocab-mode session with location + returns the row", async () => {
    mockInsertReturning.mockResolvedValue([vocabSession]);
    const s = await createVocabSession({
      userId: "u1",
      locationId: "loc1",
      locationName: "Home",
      locationNormalized: "home",
      nItemsRequested: 5,
    });
    expect(s.mode).toBe("vocab");
    expect(s.locationName).toBe("Home");
  });
});

describe("getVocabSession", () => {
  it("returns null when the session is not vocab mode", async () => {
    mockSelectLimit.mockResolvedValue([{ ...vocabSession, mode: "workout" }]);
    expect(await getVocabSession("s1", "u1")).toBeNull();
  });

  it("returns null when not found / not owned", async () => {
    mockSelectLimit.mockResolvedValue([]);
    expect(await getVocabSession("s1", "u1")).toBeNull();
  });

  it("regenerates the card queue at the session's location", async () => {
    mockSelectLimit.mockResolvedValue([vocabSession]);
    mockGenerate.mockResolvedValue([{ itemId: "w1", word: "ephemeral" }]);
    const out = await getVocabSession("s1", "u1");
    expect(out?.cards).toHaveLength(1);
    expect(mockGenerate).toHaveBeenCalledWith({ userId: "u1", locationNormalized: "home", n: 5 });
  });
});

describe("vocabSessionSummary", () => {
  it("aggregates review counts", async () => {
    mockSelectLimit.mockResolvedValue([vocabSession]);
    mockReviewRows.mockResolvedValue([
      { grade: "remember", levelBefore: 2, levelAfter: 3, word: "ephemeral" },
      { grade: "remember", levelBefore: 0, levelAfter: 1, word: "gracias" },
      { grade: "forget", levelBefore: 2, levelAfter: 1, word: "void" },
    ]);
    const summary = await vocabSessionSummary("s1", "u1");
    expect(summary).toMatchObject({ reviewed: 3, remembered: 2, forgot: 1, leveledUp: 2 });
    expect(summary?.newlyMemorized).toEqual([{ word: "ephemeral", location: "Home" }]);
  });

  it("returns null for a non-vocab / non-owned session", async () => {
    mockSelectLimit.mockResolvedValue([]);
    expect(await vocabSessionSummary("s1", "u1")).toBeNull();
  });
});
