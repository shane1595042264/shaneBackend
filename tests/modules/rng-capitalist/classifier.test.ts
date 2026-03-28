import { describe, it, expect, vi } from "vitest";
import { classifyProduct, buildClassificationPrompt } from "@/modules/rng-capitalist/classifier";

vi.mock("@/modules/shared/llm", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: '{"product_name":"Nintendo Switch OLED","price_usd":349.99,"generic_category":"gaming console","is_entertainment":true}',
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
}));

describe("buildClassificationPrompt", () => {
  it("includes the HTML in the prompt", () => {
    const prompt = buildClassificationPrompt("<html>Nintendo Switch</html>");
    expect(prompt).toContain("Nintendo Switch");
    expect(prompt).toContain("product_name");
    expect(prompt).toContain("generic_category");
  });
});

describe("classifyProduct", () => {
  it("returns parsed product info from AI response", async () => {
    const result = await classifyProduct("<html>Nintendo Switch $349.99</html>");
    expect(result.productName).toBe("Nintendo Switch OLED");
    expect(result.price).toBe(349.99);
    expect(result.genericCategory).toBe("gaming console");
    expect(result.isEntertainment).toBe(true);
  });
});
