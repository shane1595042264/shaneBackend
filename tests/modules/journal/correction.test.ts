import { describe, it, expect, vi } from "vitest";

// Mock external dependencies to avoid needing real API keys or DB connections
vi.mock("@/modules/shared/llm", () => ({ generateText: vi.fn() }));
vi.mock("@/modules/shared/embeddings", () => ({ embed: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() } }));
vi.mock("@/db/schema", () => ({
  diaryEntries: {},
  corrections: {},
  learnedFacts: {},
  activities: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock("@/modules/journal/voice-profile", () => ({
  getLatestVoiceProfile: vi.fn(),
}));

import { buildCorrectionPrompt, buildFactExtractionPrompt } from "@/modules/journal/correction";

describe("buildCorrectionPrompt", () => {
  const baseContext = {
    originalEntry: "Shane went to the gym and then had dinner alone.",
    suggestion: "I actually had dinner with my sister, not alone.",
  };

  it("should include the original entry in the prompt", () => {
    const prompt = buildCorrectionPrompt(baseContext);
    expect(prompt).toContain(baseContext.originalEntry);
  });

  it("should include the user suggestion in the prompt", () => {
    const prompt = buildCorrectionPrompt(baseContext);
    expect(prompt).toContain(baseContext.suggestion);
  });

  it("should include calendar events when provided", () => {
    const ctx = {
      ...baseContext,
      calendarEvents: "Dinner with sister @ 7pm",
    };
    const prompt = buildCorrectionPrompt(ctx);
    expect(prompt).toContain("Dinner with sister @ 7pm");
  });

  it("should include location data when provided", () => {
    const ctx = {
      ...baseContext,
      locationData: "Visited downtown restaurant district",
    };
    const prompt = buildCorrectionPrompt(ctx);
    expect(prompt).toContain("Visited downtown restaurant district");
  });

  it("should not mention calendar section when no calendar events provided", () => {
    const prompt = buildCorrectionPrompt(baseContext);
    // Should not include the calendar section label if no data
    expect(prompt).not.toContain("Dinner with sister @ 7pm");
  });

  it("should instruct to preserve voice and style", () => {
    const prompt = buildCorrectionPrompt(baseContext);
    const lowerPrompt = prompt.toLowerCase();
    expect(lowerPrompt).toMatch(/voice|style/);
  });

  it("should instruct to incorporate the correction", () => {
    const prompt = buildCorrectionPrompt(baseContext);
    const lowerPrompt = prompt.toLowerCase();
    expect(lowerPrompt).toMatch(/incorporat|rewrite|correct/);
  });
});

describe("buildFactExtractionPrompt", () => {
  const suggestion = "I had dinner with my sister, not alone.";
  const originalContent = "Shane went to the gym and had dinner alone.";
  const correctedContent = "Shane went to the gym and had dinner with his sister.";

  it("should include the suggestion in the prompt", () => {
    const prompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);
    expect(prompt).toContain(suggestion);
  });

  it("should ask for a JSON array", () => {
    const prompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);
    expect(prompt.toLowerCase()).toMatch(/json array/);
  });

  it("should ask for generalizable facts or strings", () => {
    const prompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/fact|learn/);
  });

  it("should include the original content in the prompt", () => {
    const prompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);
    expect(prompt).toContain(originalContent);
  });

  it("should include the corrected content in the prompt", () => {
    const prompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);
    expect(prompt).toContain(correctedContent);
  });
});
