import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { execute: (...a: unknown[]) => mockExecute(...a) } }));

import { generateVocabSession, vocabPreviewCounts } from "@/modules/practice/vocab-generator";

beforeEach(() => vi.clearAllMocks());

function sqlOf(callIndex: number): string {
  const arg = mockExecute.mock.calls[callIndex]?.[0] as { queryChunks?: Array<{ value?: string[] }> };
  return (arg?.queryChunks ?? [])
    .map((ch) => (ch && Array.isArray(ch.value) ? ch.value.join("") : ""))
    .join("");
}

const newRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  word: "w",
  definition: null,
  pronunciation: null,
  part_of_speech: null,
  example_sentence: null,
  language: "english",
  level: 0,
  due_at: null,
  ...over,
});

describe("generateVocabSession", () => {
  it("due query filters to the location, unmemorized, due<=now, ordered by due_at asc", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await generateVocabSession({ userId: "u1", locationNormalized: "home", n: 5 });
    const due = sqlOf(0);
    expect(due).toContain("s.due_at <= now()");
    expect(due).toContain("s.level < t.vocab_level_to_memorize");
    expect(due).toContain("ORDER BY s.due_at ASC");
  });

  it("tops up with NEW vocabulary cards not yet seen at the location when due < n", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [newRow("d1", { level: 1, due_at: new Date() })] })
      .mockResolvedValueOnce({ rows: [newRow("n1")] });
    const out = await generateVocabSession({ userId: "u1", locationNormalized: "home", n: 5 });
    expect(out).toHaveLength(2);
    expect(out[0].itemId).toBe("d1");
    expect(out[1].itemId).toBe("n1");
    const nw = sqlOf(1);
    expect(nw).toContain("v.category = 'vocabulary'");
    expect(nw).toContain("NOT EXISTS");
    expect(nw).toContain("ORDER BY random()");
  });

  it("skips the new query entirely when due already fills n", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, i) => newRow(`d${i}`, { level: 1, due_at: new Date() })),
    });
    const out = await generateVocabSession({ userId: "u1", locationNormalized: "home", n: 5 });
    expect(out).toHaveLength(5);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("maps snake_case card columns into camelCase VocabCard", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: "d1", word: "ephemeral", definition: "brief", pronunciation: "ɪˈfɛm", part_of_speech: "adj", example_sentence: "ex", language: "english", level: 2, due_at: new Date("2026-07-20") }],
    });
    const [card] = await generateVocabSession({ userId: "u1", locationNormalized: "home", n: 1 });
    expect(card.partOfSpeech).toBe("adj");
    expect(card.exampleSentence).toBe("ex");
    expect(card.level).toBe(2);
  });
});

describe("vocabPreviewCounts", () => {
  it("returns due + new counts", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ c: 3 }] })
      .mockResolvedValueOnce({ rows: [{ c: 12 }] });
    const out = await vocabPreviewCounts({ userId: "u1", locationNormalized: "home", n: 5 });
    expect(out).toEqual({ dueAvailable: 3, newAvailable: 12 });
  });
});
