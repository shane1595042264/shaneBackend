import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_PRICES_MAX_AGE_MS,
  __setLivePricesForTest,
  livePriceOf,
  livePricesStatus,
  parseLiteLlmPrices,
  refreshLivePrices,
  refreshLivePricesIfStale,
} from "@/modules/ai/live-prices";
import { costMicroUsd, priceOf, rankModels } from "@/modules/ai/catalog";

// Shaped like the real file: same keys, same fields, prices as of 2026-11-17.
const FILE = {
  sample_spec: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 },
  "claude-haiku-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1.0000000000000001e-7, output_cost_per_token: 5e-7 },
  "claude-sonnet-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
  "gemini/gemini-3.5-flash-lite": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 },
  "xai/grok-4.7": { litellm_provider: "xai", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
  "gpt-5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  "gpt-5.5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
  // Resold copies and non-chat models must not leak in.
  "us.anthropic.claude-sonnet-5-5": { litellm_provider: "bedrock_converse", mode: "chat", input_cost_per_token: 2.2e-6, output_cost_per_token: 1.1e-5 },
  "gemini-3.5-flash-lite": { litellm_provider: "vertex_ai-language-models", mode: "chat", input_cost_per_token: 9, output_cost_per_token: 9 },
  "text-embedding-3-small": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 2e-8, output_cost_per_token: 0 },
  "openai/container": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1, output_cost_per_token: 1 },
  "gpt-broken": { litellm_provider: "openai", mode: "chat", input_cost_per_token: "1", output_cost_per_token: null },
};

afterEach(() => {
  __setLivePricesForTest(null);
  vi.restoreAllMocks();
});

describe("parseLiteLlmPrices", () => {
  const table = parseLiteLlmPrices(FILE);

  it("keeps first-party chat models, per million tokens, provider prefix stripped", () => {
    expect(table.get("anthropic")?.get("claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
    expect(table.get("gemini")?.get("gemini-3.5-flash-lite")).toEqual({ input: 0.3, output: 2.5 });
    expect(table.get("xai")?.get("grok-4.7")).toEqual({ input: 2, output: 6 });
  });

  it("drops resellers, other modes, prefixed non-models and malformed rows", () => {
    expect(table.get("anthropic")?.has("us.anthropic.claude-sonnet-5-5")).toBe(false);
    expect(table.get("gemini")?.get("gemini-3.5-flash-lite")?.input).toBe(0.3); // not Vertex's 9
    expect(table.get("openai")?.has("text-embedding-3-small")).toBe(false);
    expect(table.get("openai")?.has("container")).toBe(false);
    expect(table.get("openai")?.has("gpt-broken")).toBe(false);
  });

  it("returns an empty table for anything that is not an object", () => {
    expect(parseLiteLlmPrices(null).size).toBe(0);
    expect(parseLiteLlmPrices("nope").size).toBe(0);
  });
});

describe("livePriceOf", () => {
  it("matches exactly, then the longest id extended at a - or @ boundary", () => {
    __setLivePricesForTest(parseLiteLlmPrices(FILE));
    expect(livePriceOf("anthropic", "claude-sonnet-5-5")).toEqual({ input: 2, output: 10 });
    expect(livePriceOf("anthropic", "claude-sonnet-5-5-20261001")).toEqual({ input: 2, output: 10 });
    expect(livePriceOf("openai", "gpt-5.5-2026-10-01")).toEqual({ input: 5, output: 30 });
    // "gpt-5.6" extends "gpt-5" at ".", not "-": no borrowed price.
    expect(livePriceOf("openai", "gpt-5.6")).toBeNull();
  });

  it("is null without a snapshot", () => {
    expect(livePriceOf("anthropic", "claude-sonnet-5-5")).toBeNull();
  });
});

describe("priceOf with live prices", () => {
  it("prefers the live price, and costs a call with it", () => {
    __setLivePricesForTest(parseLiteLlmPrices(FILE));
    expect(priceOf("anthropic", "claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5, known: true, source: "live" });
    // 1000 in at $0.10/M + 500 out at $0.50/M = $0.00035.
    expect(costMicroUsd("anthropic", "claude-haiku-5-5", 1000, 500)).toBe(350);
  });

  it("falls back to the built-in table, then a tier guess, without one", () => {
    expect(priceOf("anthropic", "claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5, source: "table" });
    expect(priceOf("anthropic", "claude-haiku-9")).toMatchObject({ source: "estimate", known: false });
  });

  it("ranks by the live price", () => {
    __setLivePricesForTest(parseLiteLlmPrices(FILE));
    expect(rankModels("anthropic", ["claude-sonnet-5-5", "claude-haiku-5-5"])).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });
});

function bigFile(): Record<string, unknown> {
  const file: Record<string, unknown> = { ...FILE };
  for (let i = 0; i < 60; i++) {
    file[`gpt-test-${i}`] = { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  }
  return file;
}

describe("refreshLivePrices", () => {
  it("swaps in a good file and reports it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bigFile()))) as unknown as typeof fetch;
    expect(await refreshLivePrices(fetchImpl)).toBe(true);
    // 6 real first-party chat models in FILE plus the 60 fillers.
    expect(livePricesStatus()).toMatchObject({ source: "live", models: 66 });
    expect(livePriceOf("anthropic", "claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
  });

  it("keeps the previous prices on a failed or suspiciously small file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __setLivePricesForTest(parseLiteLlmPrices(FILE));
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await refreshLivePrices(down)).toBe(false);
    const tiny = vi.fn(async () => new Response(JSON.stringify(FILE))) as unknown as typeof fetch;
    expect(await refreshLivePrices(tiny)).toBe(false);
    const thrown = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await refreshLivePrices(thrown)).toBe(false);
    expect(livePriceOf("anthropic", "claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
  });

  it("reports builtin prices when nothing was ever fetched", () => {
    expect(livePricesStatus()).toEqual({ source: "builtin", updatedAt: null, models: 0 });
  });
});

describe("refreshLivePricesIfStale", () => {
  it("does nothing while the snapshot is under a day old", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    __setLivePricesForTest(parseLiteLlmPrices(FILE), new Date());
    expect(await refreshLivePricesIfStale()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches once the snapshot is a day old", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    __setLivePricesForTest(parseLiteLlmPrices(FILE), new Date(Date.now() - LIVE_PRICES_MAX_AGE_MS - 1));
    await refreshLivePricesIfStale();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
