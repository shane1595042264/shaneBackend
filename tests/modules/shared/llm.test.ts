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
import { generateText, resetProviderHealth } from "@/modules/shared/llm";
import Anthropic from "@anthropic-ai/sdk";

describe("generateText", () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderHealth();
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
    resetProviderHealth();
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

  it("retries Gemini when the connection drops before any response", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: socket hang up"))
      .mockResolvedValueOnce(geminiOk("second try"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("second try");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 2026-11-17: on prod one knowledge note took 123s because Gemini hung for the
  // full 60s timeout and was retried in place. A timeout now moves straight on.
  it("does not retry a Gemini timeout in place, and skips Gemini on the next call", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage")) {
        return Promise.reject(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
      }
      return Promise.resolve(groqOk("groq answer"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const geminiCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("generativelanguage")).length;

    const first = await generateText({ system: "S", prompt: "P" });
    expect(first.text).toBe("groq answer");
    expect(geminiCalls()).toBe(1);

    await generateText({ system: "S", prompt: "P" });
    expect(geminiCalls()).toBe(1);
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

// 2026-11-17: providers that fail for reasons the next request can't fix are
// skipped for a while, and the knowledge classifier's `fast` chain puts Groq
// ahead of Gemini.
describe("generateText provider skipping and the fast chain", () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  const ORIGINAL_ENV = { ...process.env };

  function httpResponse(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => body,
    };
  }
  const groqOk = (text: string) =>
    httpResponse(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const geminiOk = (text: string) =>
    httpResponse(200, { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });

  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderHealth();
    const instance = new (Anthropic as unknown as new () => { messages: { create: ReturnType<typeof vi.fn> } })();
    mockCreate = instance.messages.create;
    process.env.GOOGLE_AI_API_KEY = "test-gemini-key";
    process.env.GROQ_API_KEY = "test-groq-key";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stops calling Anthropic after a no-credits error, and says why in the chain error", async () => {
    mockCreate.mockRejectedValue(new Error('400 {"message":"Your credit balance is too low to access the Anthropic API."}'));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiOk("ok")));

    await generateText({ system: "S", prompt: "P" });
    await generateText({ system: "S", prompt: "P" });

    expect(mockCreate).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(400, "nope")));
    await expect(generateText({ system: "S", prompt: "P" })).rejects.toThrow(/Anthropic: skipped until .*credit balance/);
  });

  it("tries Anthropic again once the skip window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T21:00:00Z"));
    mockCreate.mockRejectedValueOnce(new Error("400 Your credit balance is too low"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiOk("ok")));
    await generateText({ system: "S", prompt: "P" });

    vi.setSystemTime(new Date("2026-11-17T21:16:00Z"));
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "claude is back" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("claude is back");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("keeps calling Anthropic after an ordinary failure such as an overload", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("529 overloaded"), { status: 529 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiOk("ok")));

    await generateText({ system: "S", prompt: "P" });
    await generateText({ system: "S", prompt: "P" });

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("skips Gemini after a quota 429 until the window passes", async () => {
    mockCreate.mockRejectedValue(new Error("529 overloaded"));
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(String(url).includes("generativelanguage")
        ? httpResponse(429, { error: { message: "quota exceeded" } })
        : groqOk("groq")));
    vi.stubGlobal("fetch", fetchMock);
    const geminiCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("generativelanguage")).length;

    await generateText({ system: "S", prompt: "P" });
    await generateText({ system: "S", prompt: "P" });

    expect(geminiCalls()).toBe(1);
  });

  it("fast: asks Groq before Gemini, in JSON mode with the requested reasoning budget", async () => {
    mockCreate.mockRejectedValue(new Error("400 credit balance is too low"));
    const fetchMock = vi.fn().mockResolvedValue(groqOk('{"word":"x"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P", fast: true, json: true, reasoningEffort: "low" });

    expect(result.text).toBe('{"word":"x"}');
    expect(result.modelUsed).toBe("openai/gpt-oss-120b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning_effort).toBe("low");
  });

  it("fast: a Groq 429 moves on at once instead of sleeping, ending at Gemini", async () => {
    mockCreate.mockRejectedValue(new Error("400 credit balance is too low"));
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(String(url).includes("groq")
        ? httpResponse(429, "Rate limit reached. Please try again in 20s.")
        : geminiOk("gemini")));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();

    const result = await generateText({ system: "S", prompt: "P", fast: true });

    expect(result.text).toBe("gemini");
    expect(Date.now() - started).toBeLessThan(1000);
    // Both Groq models were tried once each, then Gemini.
    expect(fetchMock.mock.calls.map((c) => (String(c[0]).includes("groq") ? JSON.parse(c[1].body).model : "gemini")))
      .toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "gemini"]);
  });

  it("default order is unchanged: Gemini before Groq", async () => {
    mockCreate.mockRejectedValue(new Error("400 credit balance is too low"));
    const fetchMock = vi.fn().mockResolvedValue(geminiOk("gemini first"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({ system: "S", prompt: "P" });

    expect(result.text).toBe("gemini first");
    expect(String(fetchMock.mock.calls[0][0])).toContain("generativelanguage");
  });
});
