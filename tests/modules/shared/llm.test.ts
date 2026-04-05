import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK before importing the module under test
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
      },
    })),
    __mockCreate: mockCreate,
  };
});

// Import after mock is set up
import { generateText } from "@/modules/shared/llm";
import Anthropic from "@anthropic-ai/sdk";

describe("generateText", () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Get the mock create function from the mocked Anthropic instance
    const instance = new (Anthropic as unknown as new () => { messages: { create: ReturnType<typeof vi.fn> } })();
    mockCreate = instance.messages.create;
  });

  it("should call Anthropic API with default model and maxTokens", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello, world!" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await generateText({
      system: "You are a helpful assistant.",
      prompt: "Say hello.",
    });

    expect(result.text).toBe("Hello, world!");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("should use the default model claude-sonnet-4-20250514", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Response" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await generateText({
      system: "System prompt",
      prompt: "User prompt",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-20250514",
      })
    );
  });

  it("should use the default maxTokens of 4096", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Response" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await generateText({
      system: "System prompt",
      prompt: "User prompt",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 4096,
      })
    );
  });

  it("should accept a custom model", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Response" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await generateText({
      system: "System prompt",
      prompt: "User prompt",
      model: "claude-opus-4-5",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-5",
      })
    );
  });

  it("should accept a custom maxTokens", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Response" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await generateText({
      system: "System prompt",
      prompt: "User prompt",
      maxTokens: 1024,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 1024,
      })
    );
  });

  it("should pass system and user messages correctly", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Response" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await generateText({
      system: "You are a test assistant.",
      prompt: "Test prompt",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "You are a test assistant.",
        messages: [{ role: "user", content: "Test prompt" }],
      })
    );
  });

  it("should return usage with inputTokens and outputTokens", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Test response" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await generateText({
      system: "System",
      prompt: "Prompt",
    });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("should fall through all fallbacks when Anthropic fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API Error"));

    // Without any fallback API keys set, the last fallback (Groq) throws
    await expect(
      generateText({
        system: "System",
        prompt: "Prompt",
      })
    ).rejects.toThrow("GROQ_API_KEY not set");
  });
});
