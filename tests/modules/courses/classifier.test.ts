// tests/modules/courses/classifier.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));
vi.mock("@/modules/shared/llm", () => ({ generateText: mockGenerateText }));
// classifier.ts imports the enums from ./repo, which (from Task 3 on) imports
// the real db client and schema. Neutralize both so this stays a pure unit test.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({}));

import {
  CourseFetchError,
  classifyCourse,
  fallbackTitleFromUrl,
  fetchCourseText,
  stripHtml,
} from "@/modules/courses/classifier";

const realFetch = global.fetch;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  global.fetch = realFetch;
});

describe("stripHtml", () => {
  it("drops script/style contents, tags, and collapses whitespace", () => {
    const html =
      "<html><head><style>body { color: red }</style></head><body><h1>The  Heist</h1><script>var x=1</script><p>Act &amp; scene</p></body></html>";
    expect(stripHtml(html)).toBe("The Heist Act & scene");
  });
});

describe("fallbackTitleFromUrl", () => {
  it("de-slugs the last path segment", () => {
    expect(
      fallbackTitleFromUrl("https://x.up.railway.app/courses/pi2-heist/"),
    ).toBe("Pi2 heist");
  });
  it("handles an unusable url", () => {
    expect(fallbackTitleFromUrl("not a url")).toBe("Untitled course");
  });
});

describe("fetchCourseText", () => {
  it("returns stripped page text", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html><body><h1>Contour integrals</h1></body></html>", { status: 200 }),
    );
    await expect(fetchCourseText("https://example.com/c")).resolves.toBe("Contour integrals");
  });
  it("throws CourseFetchError on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(fetchCourseText("https://example.com/c")).rejects.toBeInstanceOf(CourseFetchError);
  });
  it("throws CourseFetchError on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchCourseText("https://example.com/c")).rejects.toBeInstanceOf(CourseFetchError);
  });
  it("throws CourseFetchError when the page has no readable text", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<script>only js</script>", { status: 200 }),
    );
    await expect(fetchCourseText("https://example.com/c")).rejects.toBeInstanceOf(CourseFetchError);
  });
});

describe("classifyCourse", () => {
  const url = "https://x.up.railway.app/courses/pi2-heist/";

  it("parses a fenced JSON response and coerces fields", async () => {
    mockGenerateText.mockResolvedValue({
      text: '```json\n{"title":"The Pi/2 Heist","description":"Contour integration walkthrough.","category":"math","difficulty":"advanced","durationMinutes":28,"tags":["Complex Analysis","integrals"]}\n```',
      modelUsed: "claude-haiku-4-5-20251001",
      usage: {},
    });
    const out = await classifyCourse("some text", url);
    expect(out).toEqual({
      title: "The Pi/2 Heist",
      description: "Contour integration walkthrough.",
      category: "math",
      difficulty: "advanced",
      durationMinutes: 28,
      tags: ["complex analysis", "integrals"],
    });
  });

  it("coerces an unknown category/difficulty to defaults and caps tags at 8", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        title: "T",
        description: "",
        category: "underwater-basketweaving",
        difficulty: "impossible",
        durationMinutes: -5,
        tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      }),
      modelUsed: "m",
      usage: {},
    });
    const out = await classifyCourse("text", url);
    expect(out.category).toBe("other");
    expect(out.difficulty).toBe("intermediate");
    expect(out.durationMinutes).toBeNull();
    expect(out.description).toBeNull();
    expect(out.tags).toHaveLength(8);
  });

  it("falls back on unparseable output", async () => {
    mockGenerateText.mockResolvedValue({ text: "I cannot help with that", modelUsed: "m", usage: {} });
    const out = await classifyCourse("text", url);
    expect(out.title).toBe("Pi2 heist");
    expect(out.category).toBe("other");
  });

  it("falls back when the LLM chain throws", async () => {
    mockGenerateText.mockRejectedValue(new Error("All LLM providers failed. Anthropic: x; Groq: y"));
    const out = await classifyCourse("text", url);
    expect(out.category).toBe("other");
    expect(out.tags).toEqual([]);
  });

  it("pins the Haiku model", async () => {
    mockGenerateText.mockResolvedValue({ text: "{}", modelUsed: "m", usage: {} });
    await classifyCourse("text", url);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001", maxTokens: 512 }),
    );
  });
});
