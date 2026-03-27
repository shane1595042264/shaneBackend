import { describe, it, expect, vi } from "vitest";

// Mock external dependencies to avoid needing real API keys or DB connections
vi.mock("@/modules/shared/llm", () => ({ generateText: vi.fn() }));
vi.mock("@/modules/shared/embeddings", () => ({ embed: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { select: vi.fn(), insert: vi.fn() } }));
vi.mock("@/db/schema", () => ({
  diaryEntries: {},
  summaries: {},
}));
vi.mock("drizzle-orm", () => ({
  between: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
}));

import { buildSummaryPrompt } from "@/modules/journal/summarizer";

describe("buildSummaryPrompt", () => {
  const sampleEntries = [
    { date: "2025-01-01", content: "Had a productive day working on the new project." },
    { date: "2025-01-02", content: "Met with friends for coffee and felt really energized." },
  ];

  it("should include all entry content in the prompt", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt).toContain(sampleEntries[0].content);
    expect(prompt).toContain(sampleEntries[1].content);
  });

  it("should include entry dates in the prompt", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt).toContain("2025-01-01");
    expect(prompt).toContain("2025-01-02");
  });

  it("should mention 'key events' in the prompt", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("key events");
  });

  it("should mention the level in the prompt for weekly", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("weekly");
  });

  it("should mention the level in the prompt for monthly", () => {
    const prompt = buildSummaryPrompt("monthly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("monthly");
  });

  it("should mention the level in the prompt for yearly", () => {
    const prompt = buildSummaryPrompt("yearly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("yearly");
  });

  it("should specify 150-200 word count for weekly level", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt).toContain("150");
    expect(prompt).toContain("200");
  });

  it("should specify 300-400 word count for monthly level", () => {
    const prompt = buildSummaryPrompt("monthly", sampleEntries);
    expect(prompt).toContain("300");
    expect(prompt).toContain("400");
  });

  it("should specify 800-1000 word count for yearly level", () => {
    const prompt = buildSummaryPrompt("yearly", sampleEntries);
    expect(prompt).toContain("800");
    expect(prompt).toContain("1000");
  });

  it("should mention emotional highlights", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("emotional");
  });

  it("should mention recurring themes", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("recurring themes");
  });

  it("should mention unresolved threads", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt.toLowerCase()).toContain("unresolved");
  });

  it("should write in third person about Shane", () => {
    const prompt = buildSummaryPrompt("weekly", sampleEntries);
    expect(prompt).toContain("Shane");
    expect(prompt.toLowerCase()).toContain("third person");
  });

  it("should handle an empty entries array", () => {
    const prompt = buildSummaryPrompt("weekly", []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
