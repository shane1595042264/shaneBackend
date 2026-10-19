// SHAN-596: the four providers a reader's key can belong to, behind one shape.
//
// Every call has a deadline (no fetch here has a default one) and every
// failure becomes a ProviderError with a `kind` the routes and the settings
// page can act on: "auth" (the key is wrong or revoked), "quota" (the key is
// fine but the account cannot pay), "model" (this model is gone or not offered
// to this key), "rate", or "other". Messages are the provider's own words,
// trimmed; they are about the reader's own account, so showing them to that
// reader is the useful thing to do.

import type { AiProvider } from "./detect";

const TIMEOUT_MS = 25_000;

export type ProviderErrorKind = "auth" | "quota" | "model" | "rate" | "other";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface GenerateInput {
  system: string;
  prompt: string;
  /** Visible answer budget. Thinking models get extra headroom on top. */
  maxTokens: number;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

function providerMessage(body: unknown, fallback: string): string {
  const b = body as { error?: { message?: string } | string; message?: string } | null;
  const msg = (typeof b?.error === "string" ? b.error : b?.error?.message) ?? b?.message ?? fallback;
  return String(msg).replace(/\s+/g, " ").slice(0, 300);
}

function classify(status: number, message: string): ProviderErrorKind {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || m.includes("api key not valid") || m.includes("invalid api key") || m.includes("incorrect api key")) {
    return "auth";
  }
  if (status === 402 || m.includes("credit balance") || m.includes("insufficient_quota") || m.includes("exceeded your current quota") || m.includes("billing")) {
    return "quota";
  }
  if (status === 404 || m.includes("no longer available") || m.includes("does not exist") || m.includes("not found") || m.includes("not supported for generatecontent")) {
    return "model";
  }
  if (status === 429) return "rate";
  return "other";
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError("other", 0, `Could not reach the provider: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = providerMessage(body, `HTTP ${res.status}`);
    throw new ProviderError(classify(res.status, message), res.status, message);
  }
  return body;
}

function bearer(key: string) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function anthropicHeaders(key: string) {
  return { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
}

function geminiHeaders(key: string) {
  return { "x-goog-api-key": key, "Content-Type": "application/json" };
}

export async function listModels(provider: AiProvider, key: string): Promise<string[]> {
  switch (provider) {
    case "openai": {
      const b = (await call("https://api.openai.com/v1/models", { headers: bearer(key) })) as { data?: { id: string }[] };
      return (b.data ?? []).map((m) => m.id);
    }
    case "xai": {
      const b = (await call("https://api.x.ai/v1/models", { headers: bearer(key) })) as { data?: { id: string }[] };
      return (b.data ?? []).map((m) => m.id);
    }
    case "anthropic": {
      const b = (await call("https://api.anthropic.com/v1/models?limit=100", { headers: anthropicHeaders(key) })) as {
        data?: { id: string }[];
      };
      return (b.data ?? []).map((m) => m.id);
    }
    case "gemini": {
      const b = (await call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
        headers: geminiHeaders(key),
      })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (b.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""));
    }
  }
}

/** Reasoning models spend hidden tokens before the visible answer. */
function isReasoning(provider: AiProvider, model: string): boolean {
  if (provider === "openai") return /^(gpt-5|o\d)/.test(model);
  if (provider === "xai") return model.includes("grok-3-mini");
  return false;
}

export async function generate(
  provider: AiProvider,
  key: string,
  model: string,
  input: GenerateInput
): Promise<GenerateResult> {
  switch (provider) {
    case "openai":
    case "xai": {
      const reasoning = isReasoning(provider, model);
      const url = provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions";
      const b = (await call(url, {
        method: "POST",
        headers: bearer(key),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
          // OpenAI's newer models take max_completion_tokens and reject
          // max_tokens; xAI documents max_tokens.
          ...(provider === "openai"
            ? { max_completion_tokens: input.maxTokens + (reasoning ? 1024 : 0) }
            : { max_tokens: input.maxTokens + (reasoning ? 1024 : 0) }),
          ...(reasoning ? { reasoning_effort: "low" } : {}),
        }),
      })) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: b.choices?.[0]?.message?.content ?? "",
        inputTokens: b.usage?.prompt_tokens ?? 0,
        outputTokens: b.usage?.completion_tokens ?? 0,
      };
    }
    case "anthropic": {
      const b = (await call("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(key),
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens,
          system: input.system,
          messages: [{ role: "user", content: input.prompt }],
        }),
      })) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      return {
        text: (b.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
        inputTokens: b.usage?.input_tokens ?? 0,
        outputTokens: b.usage?.output_tokens ?? 0,
      };
    }
    case "gemini": {
      const b = (await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: geminiHeaders(key),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          // Gemini 3.x thinks before it answers and the thinking counts
          // against this budget (SHAN-527), so leave it room.
          generationConfig: { maxOutputTokens: input.maxTokens + 2048 },
        }),
      })) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const parts = b.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.filter((p) => !p.thought).map((p) => p.text ?? "").join(""),
        inputTokens: b.usageMetadata?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output.
        outputTokens: (b.usageMetadata?.candidatesTokenCount ?? 0) + (b.usageMetadata?.thoughtsTokenCount ?? 0),
      };
    }
  }
}
