// tests/modules/ai/repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsert, mockUpdate, calls } = vi.hoisted(() => {
  const calls: { values?: unknown; conflict?: { set: unknown }; set?: unknown; where?: unknown } = {};
  return { mockInsert: vi.fn(), mockUpdate: vi.fn(), calls };
});

vi.mock("@/db/client", () => ({ db: { insert: mockInsert, update: mockUpdate } }));

vi.mock("@/db/schema", () => ({
  userAiKeys: { id: "id", userId: "user_id", provider: "provider", keySealed: "key_sealed" },
  userAiSettings: { userId: "user_id", preferredProvider: "preferred_provider", notesToKnowledge: "notes_to_knowledge" },
  aiUsageEvents: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  asc: vi.fn(),
  desc: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
}));

import { saveSettings, updateKey } from "@/modules/ai/repo";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(calls)) delete calls[k as keyof typeof calls];
});

describe("saveSettings", () => {
  const stored = { userId: "u1", preferredProvider: "gemini", notesToKnowledge: false };

  beforeEach(() => {
    mockInsert.mockReturnValue({
      values: (v: unknown) => {
        calls.values = v;
        return {
          onConflictDoUpdate: (c: { set: unknown }) => {
            calls.conflict = c;
            return { returning: async () => [stored] };
          },
        };
      },
    });
  });

  // Two PATCHes in flight used to each write back a whole merged row, so the
  // second reverted the first (SHAN-600). Each now touches only its own field.
  it("updates only the fields the patch carries", async () => {
    await saveSettings("u1", { preferredProvider: "gemini" });
    expect(calls.conflict!.set).toEqual({ preferredProvider: "gemini", updatedAt: expect.any(Date) });
    expect(calls.values).toEqual({ userId: "u1", preferredProvider: "gemini", updatedAt: expect.any(Date) });

    await saveSettings("u1", { notesToKnowledge: false });
    expect(calls.conflict!.set).toEqual({ notesToKnowledge: false, updatedAt: expect.any(Date) });
  });

  it("writes an explicit null provider", async () => {
    await saveSettings("u1", { preferredProvider: null });
    expect(calls.conflict!.set).toEqual({ preferredProvider: null, updatedAt: expect.any(Date) });
  });

  it("answers with the stored row, including a field another request wrote", async () => {
    expect(await saveSettings("u1", { preferredProvider: "gemini" })).toEqual({
      preferredProvider: "gemini",
      notesToKnowledge: false,
    });
  });
});

describe("updateKey", () => {
  beforeEach(() => {
    mockUpdate.mockReturnValue({
      set: (s: unknown) => {
        calls.set = s;
        return {
          where: (w: unknown) => {
            calls.where = w;
            return { returning: async () => [] };
          },
        };
      },
    });
  });

  it("guards on the sealed key when given one, and reports a miss as null", async () => {
    expect(await updateKey("u1", "k1", { status: "failing" }, "sealed-old")).toBeNull();
    expect(calls.where).toEqual({
      op: "and",
      args: [
        { op: "eq", a: "user_id", b: "u1" },
        { op: "eq", a: "id", b: "k1" },
        { op: "eq", a: "key_sealed", b: "sealed-old" },
      ],
    });
  });

  it("matches by owner and id alone without one", async () => {
    await updateKey("u1", "k1", { preferredModel: null });
    expect((calls.where as { args: unknown[] }).args[2]).toBeUndefined();
  });
});
