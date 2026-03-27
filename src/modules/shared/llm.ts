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

export async function generateText(
  options: GenerateTextOptions
): Promise<GenerateTextResult> {
  const {
    system,
    prompt,
    model = "claude-sonnet-4-20250514",
    maxTokens = 4096,
  } = options;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
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
