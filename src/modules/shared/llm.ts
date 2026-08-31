import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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

  for (const model of models) {
    try {
      return await callGeminiModel(apiKey, model, options);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") || msg.includes("quota")) {
        console.warn(`[llm] Gemini ${model} quota exceeded, trying next model...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("All Gemini models exhausted their free-tier quota");
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  options: GenerateTextOptions & { maxTokens: number }
): Promise<GenerateTextResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
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
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq API error ${response.status}: ${body}`);
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
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));

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
  try {
    return await generateWithGemini({ system, prompt, maxTokens });
  } catch (err) {
    console.warn("[llm] Gemini failed, trying Groq:", (err as Error).message);
  }

  // Last resort: Groq Llama (free tier)
  try {
    return await generateWithGroq({ system, prompt, maxTokens });
  } catch (err) {
    const groqError = (err as Error).message;
    throw new Error(`All LLM providers failed. Anthropic: ${anthropicError}; Groq: ${groqError}`);
  }
}
