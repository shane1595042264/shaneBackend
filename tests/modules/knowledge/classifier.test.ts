import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));

vi.mock("@/modules/shared/llm", () => ({
  generateText: mockGenerateText,
}));

import { classifyNote } from "@/modules/knowledge/classifier";

beforeEach(() => vi.clearAllMocks());

describe("classifyNote source extraction", () => {
  it("returns null source when input has no source mention", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        category: "vocabulary",
        word: "hola",
        language: "spanish",
        definition: "hello",
        pronunciation: "",
        partOfSpeech: "interjection",
        exampleSentence: "",
        labels: [],
        source: null,
      }),
      modelUsed: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyNote("hola = hello");
    expect(result.source).toBeNull();
  });

  it("extracts source.book from input that mentions a book", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        category: "vocabulary",
        word: "дворецкий",
        language: "russian",
        definition: "butler",
        pronunciation: "",
        partOfSpeech: "noun",
        exampleSentence: "",
        labels: [],
        source: {
          book: "War and Peace",
          rawContext: "Read this in War and Peace: дворецкий = butler",
        },
      }),
      modelUsed: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyNote(
      "Read this in War and Peace: дворецкий = butler"
    );
    expect(result.source).toEqual({
      app: null,
      book: "War and Peace",
      author: null,
      location: null,
      rawContext: "Read this in War and Peace: дворецкий = butler",
    });
  });

  it("extracts source.app when input mentions a source app", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        category: "vocabulary",
        word: "schadenfreude",
        language: "german",
        definition: "pleasure at another's misfortune",
        pronunciation: "",
        partOfSpeech: "noun",
        exampleSentence: "",
        labels: [],
        source: { app: "Kindle", rawContext: "From my Kindle: schadenfreude" },
      }),
      modelUsed: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyNote(
      "From my Kindle: schadenfreude — pleasure at another's misfortune"
    );
    expect(result.source?.app).toBe("Kindle");
  });

  it("returns null source on malformed LLM response (fallback path)", async () => {
    mockGenerateText.mockResolvedValue({
      text: "this is not json at all",
      modelUsed: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyNote("hola");
    expect(result.source).toBeNull();
  });

  it("returns null source when all source fields are null (degenerate case)", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        category: "vocabulary",
        word: "x",
        language: "english",
        definition: "y",
        pronunciation: "",
        partOfSpeech: "noun",
        exampleSentence: "",
        labels: [],
        source: { app: null, book: null, author: null, location: null, rawContext: null },
      }),
      modelUsed: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyNote("x = y");
    expect(result.source).toBeNull();
  });
});
