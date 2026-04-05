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

  // Try multiple models in case one has exhausted its free-tier quota
  const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.0-flash-lite"];

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
      generationConfig: { maxOutputTokens: options.maxTokens },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const usageMetadata = data.usageMetadata ?? {};

  return {
    text,
    usage: {
      inputTokens: usageMetadata.promptTokenCount ?? 0,
      outputTokens: usageMetadata.candidatesTokenCount ?? 0,
    },
  };
}

export async function generateText(
  options: GenerateTextOptions
): Promise<GenerateTextResult> {
  const {
    system,
    prompt,
    model = "claude-sonnet-4-20250514",
    maxTokens = 4096,
  } = options;

  // Try Anthropic first
  try {
    return await generateWithAnthropic({ system, prompt, model, maxTokens });
  } catch (err) {
    console.warn("[llm] Anthropic failed, falling back to Gemini Flash:", (err as Error).message);
  }

  // Fallback to Google Gemini Flash (free tier)
  return await generateWithGemini({ system, prompt, maxTokens });
}
