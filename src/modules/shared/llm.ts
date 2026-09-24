import Anthropic from "@anthropic-ai/sdk";

// Every provider call needs an explicit deadline: neither Bun nor undici
// applies a default request timeout, so a provider that accepts the connection
// and then goes quiet hangs the await forever, and the Anthropic SDK's own
// default is 10 minutes. Every prompt reaching this module is a short
// classification or enrichment call. 60s is deliberately looser than the 10s
// the HTML scrapers use (courses/classifier.ts, scoreboard/icon-search.ts)
// because Gemini 3.x is a thinking model working through a maxTokens + 4096
// budget before it emits a first visible token (SHAN-527).
const PROVIDER_TIMEOUT_MS = 60_000;

const client = new Anthropic({ timeout: PROVIDER_TIMEOUT_MS });

// A Gemini 5xx means the model is momentarily overloaded, which is by far its
// most common failure and clears on its own within a second or two. Retrying
// in place is much cheaper than spending the chain's last provider, so give it
// a small bounded budget: attempts at t=0, +400ms, +800ms, then give up.
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_MS = 400;

export interface GenerateTextOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  modelUsed: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** A provider answered, but with a non-2xx status. Carries the status so
 * retry decisions read the code instead of regexing a response body that may
 * itself contain digits. */
class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** The request never produced a response at all: timed out, DNS failed, or the
 * connection dropped. Scoped to the `fetch` call itself so a bug in our own
 * response parsing is never mistaken for a flaky network and retried. */
class ProviderNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

/** Worth trying the same model again: the failure is about the provider's
 * current load or the network, not about the request we sent. */
function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderNetworkError) return true;
  if (err instanceof ProviderHttpError) return err.status >= 500;
  return false;
}

/** The model's free-tier allowance is gone. Backoff cannot bring a daily quota
 * back, so this moves to the next model rather than retrying in place. */
function isQuotaError(err: unknown): boolean {
  if (err instanceof ProviderHttpError && err.status === 429) return true;
  return err instanceof Error && err.message.includes("quota");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Provider error bodies are long and sometimes embed credentials. Keep log
 * lines readable; the full message still reaches the thrown error, which
 * app.ts logs server-side and scrubs before answering a client (SHAN-351). */
function forLog(message: string): string {
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

async function generateWithAnthropic(
  options: GenerateTextOptions & { maxTokens: number; model: string }
): Promise<GenerateTextResult> {
  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
  });

  const textContent = response.content.find((block) => block.type === "text");
  const text = textContent && textContent.type === "text" ? textContent.text : "";

  return {
    text,
    modelUsed: options.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

async function generateWithGemini(
  options: GenerateTextOptions & { maxTokens: number }
): Promise<GenerateTextResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_AI_API_KEY not set — cannot use Gemini fallback");
  }

  // gemini-2.0-flash / -lite were retired by Google (404 as of 2026-08,
  // SHAN-437). gemini-3.6-flash is the replacement the retirement error names.
  const models = ["gemini-3.6-flash"];
  let lastError: unknown;

  for (const model of models) {
    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        return await callGeminiModel(apiKey, model, options);
      } catch (err) {
        lastError = err;

        if (isQuotaError(err)) {
          console.warn(`[llm] Gemini ${model} quota exceeded, trying next model...`);
          break;
        }

        if (isRetryableProviderError(err) && attempt < GEMINI_MAX_ATTEMPTS) {
          const delayMs = GEMINI_RETRY_BASE_MS * 2 ** (attempt - 1);
          console.warn(
            `[llm] Gemini ${model} attempt ${attempt}/${GEMINI_MAX_ATTEMPTS} failed transiently, retrying in ${delayMs}ms:`,
            forLog((err as Error).message)
          );
          await sleep(delayMs);
          continue;
        }

        // Anything else (400, a retired model, an empty answer) is about this
        // request, not the provider's mood. Retrying only adds latency.
        throw err;
      }
    }
  }

  // Only reachable by exhausting the model list on quota errors. Rethrow the
  // real provider error rather than a summary so the reason survives into the
  // chain-exhaustion message.
  throw lastError instanceof Error
    ? lastError
    : new Error("All Gemini models exhausted their free-tier quota");
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  options: GenerateTextOptions & { maxTokens: number }
): Promise<GenerateTextResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.system }] },
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        // Gemini 3.x thinking models spend hidden reasoning tokens from
        // maxOutputTokens (candidatesTokenCount excludes them), so a tight
        // caller budget like 512 truncates the visible answer mid-JSON.
        // Give thinking headroom on top of the caller's budget (SHAN-437).
        generationConfig: { maxOutputTokens: options.maxTokens + 4096 },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderNetworkError(`Gemini ${model} request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHttpError(response.status, `Gemini API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  // Gemini 3.x is a thinking model: join every non-thought text part instead
  // of assuming parts[0], and treat an empty answer (e.g. the whole token
  // budget spent on thinking) as a failure so the chain falls through to Groq
  // rather than returning "" to a classifier.
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (!text) {
    throw new Error(`Gemini ${model} returned no text`);
  }
  const usageMetadata = data.usageMetadata ?? {};

  return {
    text,
    modelUsed: model,
    usage: {
      inputTokens: usageMetadata.promptTokenCount ?? 0,
      outputTokens: usageMetadata.candidatesTokenCount ?? 0,
    },
  };
}

async function callGroqApi(
  apiKey: string,
  model: string,
  options: GenerateTextOptions & { maxTokens: number }
): Promise<GenerateTextResult> {
  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.prompt },
        ],
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderNetworkError(`Groq ${model} request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHttpError(response.status, `Groq API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? {};

  return {
    text,
    modelUsed: model,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    },
  };
}

async function generateWithGroq(
  options: GenerateTextOptions & { maxTokens: number }
): Promise<GenerateTextResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not set — cannot use Groq fallback");
  }

  // llama-3.3-70b-versatile / llama-3.1-8b-instant were retired by Groq
  // (404 as of 2026-08, SHAN-437). gpt-oss is Groq's current free chat tier.
  const models = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

  for (const model of models) {
    try {
      return await callGroqApi(apiKey, model, options);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429")) {
        // Extract retry delay from error message
        const retryMatch = msg.match(/try again in (\d+(?:\.\d+)?)s/);
        const delaySec = retryMatch ? Math.min(Math.ceil(Number(retryMatch[1])), 30) : 25;
        console.warn(`[llm] Groq ${model} rate limited, waiting ${delaySec}s then retrying...`);
        await sleep(delaySec * 1000);

        try {
          return await callGroqApi(apiKey, model, options);
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message;
          if (retryMsg.includes("429") && model !== models[models.length - 1]) {
            console.warn(`[llm] Groq ${model} still rate limited, trying smaller model...`);
            continue;
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }
  throw new Error("All Groq models failed");
}

export async function generateText(
  options: GenerateTextOptions & { noFallback?: boolean }
): Promise<GenerateTextResult> {
  const {
    system,
    prompt,
    model = "claude-sonnet-4-20250514",
    maxTokens = 4096,
    noFallback = false,
  } = options;

  // Try Anthropic first
  let anthropicError: string | undefined;
  try {
    return await generateWithAnthropic({ system, prompt, model, maxTokens });
  } catch (err) {
    anthropicError = (err as Error).message;
    if (noFallback) throw err;
    console.warn("[llm] Anthropic failed, trying Gemini:", anthropicError);
  }

  // Fallback to Google Gemini Flash (free tier)
  let geminiError: string | undefined;
  try {
    return await generateWithGemini({ system, prompt, maxTokens });
  } catch (err) {
    geminiError = (err as Error).message;
    console.warn("[llm] Gemini failed, trying Groq:", geminiError);
  }

  // Last resort: Groq Llama (free tier)
  try {
    return await generateWithGroq({ system, prompt, maxTokens });
  } catch (err) {
    const groqError = (err as Error).message;
    // The "All LLM providers failed" prefix is a contract: knowledge,
    // vocabulary and trip-groups routes match on it for 502 semantics, and
    // app.ts scrubs the whole string before it reaches a client. Gemini's
    // reason is included because it is the middle link that used to fail
    // silently into console.warn only (SHAN-527).
    throw new Error(
      `All LLM providers failed. Anthropic: ${anthropicError}; Gemini: ${geminiError}; Groq: ${groqError}`
    );
  }
}
