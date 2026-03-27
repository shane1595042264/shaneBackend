import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/modules/shared/llm before importing the module under test
vi.mock("@/modules/shared/llm", () => ({
  generateText: vi.fn(),
}));

// Mock @/db/client to avoid needing a real DB connection
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

// Mock drizzle-orm
vi.mock("drizzle-orm", () => ({
  desc: vi.fn((col) => ({ col, direction: "desc" })),
  eq: vi.fn(),
}));

// Mock @/db/schema
vi.mock("@/db/schema", () => ({
  voiceProfiles: {},
}));

import { buildVoiceProfilePrompt, deriveVoiceProfile } from "@/modules/journal/voice-profile";
import { generateText } from "@/modules/shared/llm";

const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

describe("buildVoiceProfilePrompt", () => {
  it("should include all provided writing samples in the prompt", () => {
    const samples = [
      "I went to the coffee shop today.",
      "Today was wild — started a new project.",
    ];
    const prompt = buildVoiceProfilePrompt(samples);

    expect(prompt).toContain(samples[0]);
    expect(prompt).toContain(samples[1]);
  });

  it("should mention voice profile in the prompt", () => {
    const prompt = buildVoiceProfilePrompt(["Some sample text."]);
    expect(prompt.toLowerCase()).toContain("voice profile");
  });

  it("should mention key voice dimensions to extract", () => {
    const prompt = buildVoiceProfilePrompt(["Some sample."]);
    // Should mention at least some of the key dimensions
    const lowerPrompt = prompt.toLowerCase();
    const hasVocabulary = lowerPrompt.includes("vocabulary");
    const hasTone = lowerPrompt.includes("tone");
    const hasSentence = lowerPrompt.includes("sentence");
    expect(hasVocabulary || hasTone || hasSentence).toBe(true);
  });

  it("should request output under 500 words", () => {
    const prompt = buildVoiceProfilePrompt(["Sample text."]);
    expect(prompt).toContain("500");
  });

  it("should handle multiple samples", () => {
    const samples = ["Sample 1", "Sample 2", "Sample 3"];
    const prompt = buildVoiceProfilePrompt(samples);
    samples.forEach((s) => expect(prompt).toContain(s));
  });

  it("should handle a single sample", () => {
    const sample = "Just one entry here.";
    const prompt = buildVoiceProfilePrompt([sample]);
    expect(prompt).toContain(sample);
  });
});

describe("deriveVoiceProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return the text from generateText", async () => {
    const fixedText = "This author uses casual language with frequent humor.";
    mockGenerateText.mockResolvedValueOnce({
      text: fixedText,
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await deriveVoiceProfile(["Sample writing here."]);

    expect(result).toBe(fixedText);
  });

  it("should call generateText with model claude-sonnet-4-20250514", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Voice profile result.",
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    await deriveVoiceProfile(["Sample writing."]);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-20250514",
      })
    );
  });

  it("should call generateText with a literary analyst system prompt", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Profile text.",
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    await deriveVoiceProfile(["Sample."]);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("literary analyst"),
      })
    );
  });

  it("should pass the built prompt to generateText", async () => {
    const samples = ["Unique sample text for testing purposes."];
    mockGenerateText.mockResolvedValueOnce({
      text: "Profile.",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await deriveVoiceProfile(samples);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(samples[0]),
      })
    );
  });
});
