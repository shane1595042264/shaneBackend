import { describe, it, expect, beforeAll } from "vitest";
import { detectProvider, keyHint } from "@/modules/ai/detect";
import { costMicroUsd, isTextModel, priceOf, rankModels } from "@/modules/ai/catalog";
import { openKey, sealKey } from "@/modules/ai/crypto";

describe("detectProvider", () => {
  const gemini = "AIza" + "A".repeat(35);
  it.each([
    ["sk-ant-api03-" + "x".repeat(90), "anthropic"],
    ["sk-proj-" + "x".repeat(60), "openai"],
    ["sk-svcacct-" + "x".repeat(60), "openai"],
    ["sk-" + "x".repeat(48), "openai"],
    ["xai-" + "x".repeat(80), "xai"],
    [gemini, "gemini"],
    [`  ${gemini}\n`, "gemini"],
  ])("recognises %s", (key, provider) => {
    expect(detectProvider(key)).toEqual({ provider });
  });

  it("checks Anthropic before the bare sk- that means OpenAI", () => {
    expect(detectProvider("sk-ant-api03-" + "y".repeat(40)).provider).toBe("anthropic");
  });

  it.each([
    ["gsk_" + "x".repeat(50), /Groq/],
    ["sk-or-v1-" + "x".repeat(60), /OpenRouter/],
    ["sk-ant-admin01-" + "x".repeat(60), /Admin key/],
    ["sk-admin-" + "x".repeat(60), /Admin key/],
    ["hello-" + "x".repeat(40), /Could not tell/],
    ["sk-abc", /too short/],
    ["sk-" + "x".repeat(20) + " " + "y".repeat(20), /no spaces/],
    ["AIza" + "A".repeat(20), /Could not tell/],
  ])("names what is wrong with %s", (key, reason) => {
    const d = detectProvider(key);
    expect(d.provider).toBeNull();
    expect(d.provider === null && d.reason).toMatch(reason);
  });

  it("keeps only the last four characters as a hint", () => {
    expect(keyHint("sk-proj-abcdefgh1234")).toBe("1234");
  });
});

describe("catalog", () => {
  it("keeps text models and drops speech, image, music and agent models", () => {
    const listed = [
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-preview-tts",
      "gemini-3-pro-image",
      "lyria-3.5",
      "gemini-robotics-er-2-preview",
      "gemma-4-31b-it",
      "deep-research-preview-04-2026",
      "gemini-3.5-transcribe",
    ];
    expect(listed.filter((m) => isTextModel("gemini", m))).toEqual(["gemini-3.5-flash-lite"]);
    expect(isTextModel("openai", "text-embedding-3-small")).toBe(false);
    expect(isTextModel("openai", "whisper-1")).toBe(false);
    expect(isTextModel("openai", "gpt-5-nano")).toBe(true);
  });

  it("ranks the cheap tier first and prefers the newer stable model on a tie", () => {
    // Real Gemini list from 2026-10-18, trimmed.
    const ranked = rankModels("gemini", [
      "gemini-2.5-pro",
      "gemini-3.6-flash",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-preview-tts",
    ]);
    expect(ranked[0]).toBe("gemini-3.5-flash-lite");
    expect(ranked.indexOf("gemini-3.1-flash-lite")).toBeLessThan(ranked.indexOf("gemini-3.1-flash-lite-preview"));
    expect(ranked.at(-1)).toBe("gemini-2.5-pro");
    expect(ranked).not.toContain("gemini-2.5-flash-preview-tts");
  });

  it("puts haiku before sonnet before opus, and nano before mini before full", () => {
    expect(rankModels("anthropic", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    expect(rankModels("openai", ["gpt-5", "gpt-5-mini", "gpt-5-nano"])).toEqual(["gpt-5-nano", "gpt-5-mini", "gpt-5"]);
  });

  it("uses the longest known prefix and marks tier guesses as estimates", () => {
    expect(priceOf("openai", "gpt-4.1-mini-2025-04-14")).toEqual({ input: 0.4, output: 1.6, known: true });
    expect(priceOf("gemini", "gemini-9-flash-lite").known).toBe(false);
  });

  it("estimates the cost of a call in millionths of a dollar", () => {
    // gpt-5-nano: $0.05/M in, $0.40/M out.
    expect(costMicroUsd("openai", "gpt-5-nano", 1000, 500)).toBe(250);
  });
});

describe("sealKey / openKey", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-sealing";
  });

  it("round-trips and never stores the key in the clear", () => {
    const key = "sk-proj-" + "z".repeat(50);
    const sealed = sealKey(key);
    expect(sealed).not.toContain("zzzz");
    expect(openKey(sealed)).toBe(key);
  });

  it("uses a fresh nonce every time", () => {
    expect(sealKey("same")).not.toBe(sealKey("same"));
  });

  it("refuses a tampered seal", () => {
    const sealed = Buffer.from(sealKey("secret-key-value"), "base64");
    sealed[sealed.length - 1] ^= 1;
    expect(() => openKey(sealed.toString("base64"))).toThrow();
  });
});
