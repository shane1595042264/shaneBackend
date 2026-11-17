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
  /** Groq only: ask for a JSON object back (OpenAI `response_format`). */
  json?: boolean;
  /** Groq only: gpt-oss reasoning budget. "low" keeps a grading call under a second. */
  reasoningEffort?: "low" | "medium" | "high";
}

// ── Provider health ──────────────────────────────────────────────────────────
// A provider that failed for a reason the next request won't fix is skipped for
// a while instead of costing every call a round trip. Measured on prod
// (2026-11-17, POST /knowledge/notes from Nibbler): every note first paid an
// Anthropic "credit balance is too low" 400, then Gemini 3.6 Flash hung for the
// full 60s timeout and was retried in place, so single notes took 71s, 123s and
// 66s; Groq, reached last, answered in about a second. Process-local on
// purpose: one container, and a restart simply re-probes every provider.
type Provider = "anthropic" | "gemini" | "groq";

/** No credits / bad key: nothing changes until a human tops up or rotates it. */
const ACCOUNT_SKIP_MS = 15 * 60_000;
/** Free-tier quota gone: it refills on the provider's schedule, not ours. */
const QUOTA_SKIP_MS = 15 * 60_000;
/** Hung for the whole timeout: a free tier that does that tends to keep doing it. */
const TIMEOUT_SKIP_MS = 5 * 60_000;

const skipUntil: Record<Provider, number> = { anthropic: 0, gemini: 0, groq: 0 };
const skipWhy: Record<Provider, string> = { anthropic: "", gemini: "", groq: "" };

function skipProvider(provider: Provider, ms: number, why: string): void {
  skipUntil[provider] = Date.now() + ms;
  skipWhy[provider] = why;
  console.warn(`[llm] skipping ${provider} for ${Math.round(ms / 60_000)} min: ${forLog(why)}`);
}

/** Why `provider` is being skipped right now, or null if it may be tried. */
function skipReason(provider: Provider): string | null {
  if (Date.now() >= skipUntil[provider]) return null;
  return `skipped until ${new Date(skipUntil[provider]).toISOString()} (${forLog(skipWhy[provider])})`;
}

/** Tests only: forget every skip so cases don't leak into each other. */
export function resetProviderHealth(): void {
  for (const p of Object.keys(skipUntil) as Provider[]) {
    skipUntil[p] = 0;
    skipWhy[p] = "";
  }
}

/** Anthropic failures that only a human can clear (SHAN-437: the account has no credits). */
function isAnthropicAccountError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) return true;
  return err instanceof Error && /credit balance is too low/i.test(err.message);
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

/** The request never produced a response at all: DNS failed or the connection
 * dropped. Scoped to the `fetch` call itself so a bug in our own response
 * parsing is never mistaken for a flaky network and retried. */
class ProviderNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

/** The provider accepted the request and then said nothing for the whole
 * PROVIDER_TIMEOUT_MS. Not retried in place: a model that just took 60s to not
 * answer is not "momentarily overloaded", and three tries made one knowledge
 * note take two minutes on prod. The chain moves on and skips it for a while. */
class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

function isAbortTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Wrap a failed `fetch`: a deadline becomes ProviderTimeoutError, anything else ProviderNetworkError. */
function fetchFailure(label: string, err: unknown): Error {
  const message = `${label} request failed: ${(err as Error).message}`;
  return isAbortTimeout(err) ? new ProviderTimeoutError(message) : new ProviderNetworkError(message);
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
          skipProvider("gemini", QUOTA_SKIP_MS, (err as Error).message);
          break;
        }

        if (err instanceof ProviderTimeoutError) {
          skipProvider("gemini", TIMEOUT_SKIP_MS, err.message);
          throw err;
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
    throw fetchFailure(`Gemini ${model}`, err);
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
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw fetchFailure(`Groq ${model}`, err);
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
  options: GenerateTextOptions & { maxTokens: number },
  /** Sleep out a 429 and retry (up to 30s). The fast chain passes false: its caller is waiting. */
  waitOutRateLimit = true
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
      if (err instanceof ProviderTimeoutError) {
        skipProvider("groq", TIMEOUT_SKIP_MS, msg);
        throw err;
      }
      if (msg.includes("429") && !waitOutRateLimit) {
        if (model !== models[models.length - 1]) continue;
        throw err;
      }
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

/**
 * SHAN-575: a short, interactive call where a person is waiting on the answer
 * (knowledge recite grading). Free tier only, smallest model first, and no
 * sleeping: generateWithGroq waits up to 30s out a 429 because a background
 * classifier can afford to, and a learner staring at a spinner cannot.
 *
 * Order: Groq gpt-oss-20b (measured 0.4-0.8s on a grading prompt), then
 * gpt-oss-120b, then Gemini Flash. Anthropic is left out on purpose: the
 * account has no credits (SHAN-437) and every recite attempt would pay its
 * round trip just to fail. Throws "Small LLM chain failed: ..." when all three
 * do, so the caller can fall back to something that needs no provider.
 */
export async function generateSmallText(
  options: Omit<GenerateTextOptions, "model">
): Promise<GenerateTextResult> {
  const maxTokens = options.maxTokens ?? 600;
  const errors: string[] = [];
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]) {
      try {
        const result = await callGroqApi(groqKey, model, { ...options, maxTokens });
        if (result.text.trim()) return result;
        errors.push(`Groq ${model}: empty answer`);
      } catch (err) {
        errors.push(forLog((err as Error).message));
      }
    }
  } else {
    errors.push("GROQ_API_KEY not set");
  }
  try {
    return await generateWithGemini({ ...options, maxTokens });
  } catch (err) {
    errors.push(forLog((err as Error).message));
  }
  throw new Error(`Small LLM chain failed: ${errors.join("; ")}`);
}

export async function generateText(
  options: GenerateTextOptions & {
    noFallback?: boolean;
    /**
     * A short call someone is waiting on (knowledge classification): after
     * Anthropic, try Groq before Gemini and never sleep out a Groq 429. Groq
     * answers a classification in about a second; Gemini 3.6 Flash is a
     * thinking model whose free tier has hung for the full 60s on prod. The
     * default order (Gemini before Groq) is unchanged for everything else.
     */
    fast?: boolean;
  }
): Promise<GenerateTextResult> {
  const {
    system,
    prompt,
    model = "claude-sonnet-4-20250514",
    maxTokens = 4096,
    noFallback = false,
    fast = false,
    json,
    reasoningEffort,
  } = options;
  const errors: Record<Provider, string | undefined> = { anthropic: undefined, gemini: undefined, groq: undefined };

  // Anthropic first whenever it is usable: the callers pin a Claude model.
  const anthropicSkip = skipReason("anthropic");
  if (anthropicSkip) {
    errors.anthropic = anthropicSkip;
    if (noFallback) throw new Error(`Anthropic ${anthropicSkip}`);
  } else {
    try {
      return await generateWithAnthropic({ system, prompt, model, maxTokens });
    } catch (err) {
      errors.anthropic = (err as Error).message;
      if (isAnthropicAccountError(err)) skipProvider("anthropic", ACCOUNT_SKIP_MS, errors.anthropic);
      if (noFallback) throw err;
      console.warn("[llm] Anthropic failed, trying the fallbacks:", forLog(errors.anthropic));
    }
  }

  const fallbacks: Provider[] = fast ? ["groq", "gemini"] : ["gemini", "groq"];
  for (const provider of fallbacks) {
    const skip = skipReason(provider);
    if (skip) {
      errors[provider] = skip;
      continue;
    }
    try {
      return provider === "gemini"
        ? await generateWithGemini({ system, prompt, maxTokens })
        : await generateWithGroq({ system, prompt, maxTokens, json, reasoningEffort }, !fast);
    } catch (err) {
      errors[provider] = (err as Error).message;
      console.warn(`[llm] ${provider} failed:`, forLog(errors[provider]!));
    }
  }

  // The "All LLM providers failed" prefix is a contract: knowledge,
  // vocabulary and trip-groups routes match on it for 502 semantics, and
  // app.ts scrubs the whole string before it reaches a client. Every provider
  // is named, skipped ones included, so the reason survives (SHAN-527).
  throw new Error(
    `All LLM providers failed. Anthropic: ${errors.anthropic}; Gemini: ${errors.gemini}; Groq: ${errors.groq}`
  );
}
