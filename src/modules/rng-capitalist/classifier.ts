import { generateText } from "@/modules/shared/llm";

export interface ClassifiedProduct {
  productName: string;
  price: number;
  genericCategory: string;
  isEntertainment: boolean;
}

export function buildClassificationPrompt(html: string): string {
  return `Extract from this product page HTML:
1. product_name: the exact product name
2. price_usd: the price in USD (number only, no currency symbol). If multiple prices, use the main/current price.
3. generic_category: a short 1-3 word generalized category (e.g., "sex toy", "gaming console", "headphones"). This should be broad enough that similar products would fall under the same category.
4. is_entertainment: true if this is an entertainment/luxury/want purchase, false if it's a genuine necessity (food, medicine, basic clothing, utilities, hygiene)

Return JSON only: {"product_name":"...","price_usd":0.00,"generic_category":"...","is_entertainment":true}

HTML:
${html}`;
}

export async function classifyProduct(html: string): Promise<ClassifiedProduct> {
  const result = await generateText({
    system: "You extract product information from HTML. Return ONLY valid JSON, no markdown, no explanation.",
    prompt: buildClassificationPrompt(html),
    model: "claude-haiku-4-5-20251001",
    maxTokens: 256,
  });
  const cleaned = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    productName: parsed.product_name,
    price: Number(parsed.price_usd),
    genericCategory: parsed.generic_category.toLowerCase(),
    isEntertainment: Boolean(parsed.is_entertainment),
  };
}
