import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// SHAN-527: the chain has to survive a provider that is momentarily overloaded
// rather than spending its last fallback on the first blip, and it has to bound
// every request so a stalled provider cannot wedge the caller forever.
describe("generateText provider resilience", () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  const ORIGINAL_ENV = { ...process.env };

  /** Minimal stand-in for the parts of Response that llm.ts actually reads. */
  function httpResponse(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => body,
    };
  }

  function geminiOk(text: string) {
    return httpResponse(200, {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 11 },
    });
  }

  function groqOk(text: string) {
    return httpResponse(200, {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const instance = new (Anthropic as unknown as new () => { messages: { create: ReturnType<typeof vi.fn> } })();
    mockCreate = instance.messages.create;
    // Every case here is about what happens AFTER Anthropic is unavailable,
    // which is the site's real steady state while the account has no credits.
    mockCreate.mockRejectedValue(new Error("400 credit balance is too low"));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("retries Gemini after a 503 and returns the retry's answer", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpResponse(503, { error: { message: "model overloaded" } }))
      .mockResolvedValueOnce(geminiOk("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("recovered");
    expect(result.modelUsed).toBe("gemini-3.6-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on Gemini after the retry budget and falls through to Groq", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage")) {
        return Promise.resolve(httpResponse(503, { error: { message: "overloaded" } }));
      }
      return Promise.resolve(groqOk("groq answer"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("groq answer");
    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage")
    );
    expect(geminiCalls).toHaveLength(3);
  });

  it("does not retry a Gemini 400, which is about the request not the load", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage")) {
        return Promise.resolve(httpResponse(400, { error: { message: "bad request" } }));
      }
      return Promise.resolve(groqOk("groq answer"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await generateText({ system: "S", prompt: "P" });

    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage")
    );
    expect(geminiCalls).toHaveLength(1);
  });

  it("does not retry a Gemini 429, because backoff cannot restore a quota", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage")) {
        return Promise.resolve(httpResponse(429, { error: { message: "quota exceeded" } }));
      }
      return Promise.resolve(groqOk("groq answer"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await generateText({ system: "S", prompt: "P" });

    const geminiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("generativelanguage")
    );
    expect(geminiCalls).toHaveLength(1);
  });

  it("retries Gemini when the request never lands at all", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(geminiOk("second try"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("second try");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the Gemini request with an abort signal", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    const fetchMock = vi.fn().mockResolvedValue(geminiOk("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateText({ system: "S", prompt: "P" });

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the Groq request with an abort signal", async () => {
    process.env.GROQ_API_KEY = "test-groq-key";
    delete process.env.GOOGLE_AI_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue(groqOk("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("ok");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("names every provider, Gemini included, when the whole chain is exhausted", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    delete process.env.GROQ_API_KEY;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(httpResponse(400, { error: { message: "gemini is unhappy" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateText({ system: "S", prompt: "P" })).rejects.toThrow(
      /^All LLM providers failed\..*Gemini: .*gemini is unhappy.*Groq: .*GROQ_API_KEY not set/s
    );
  });
});
