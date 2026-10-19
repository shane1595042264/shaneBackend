// SHAN-596: which of a key's models can explain text, what each costs, and
// which is cheapest.
//
// A provider's model list is the ground truth for what exists, but it is not a
// list of chat models: Gemini's mixes in text-to-speech, image, music,
// robotics and research agents, OpenAI's has embeddings, Whisper and image
// models. isTextModel keeps only what can answer a text prompt.
//
// Prices are the providers' published list prices in US dollars per million
// tokens, where known. Model names outlive any table, so an unknown model is
// priced by its tier word ("lite", "nano", "mini", "flash", "haiku", "pro",
// "opus"...), and that estimate is marked as one. The ranking only has to put
// the cheap tier first; the key check then calls models in that order until
// one actually answers, because a listed model can still refuse a new user
// (gemini-2.5-flash-lite does: listed, then 404 "no longer available").

import type { AiProvider } from "./detect";

export interface Price {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** False when this is a tier estimate for a model the table does not know. */
  known: boolean;
}

const NON_TEXT =
  /embed|tts|transcribe|whisper|audio|realtime|speech|image|imagen|veo|lyria|sora|dall-?e|moderation|robotics|computer-use|antigravity|deep-research|omni|nano-banana|search|aqa|gemma|learnlm|customtools|babbage|davinci|-instruct|codex|vision-preview/i;

export function isTextModel(provider: AiProvider, id: string): boolean {
  if (NON_TEXT.test(id)) return false;
  switch (provider) {
    case "openai":
      return /^(gpt-|o\d|chatgpt-)/.test(id);
    case "anthropic":
      return id.startsWith("claude-");
    case "gemini":
      return id.startsWith("gemini-");
    case "xai":
      return id.startsWith("grok-");
  }
}

// Longest matching prefix wins, so "gpt-4.1-mini" beats "gpt-4.1".
const KNOWN: Record<AiProvider, [prefix: string, input: number, output: number][]> = {
  openai: [
    ["gpt-5-nano", 0.05, 0.4],
    ["gpt-5-mini", 0.25, 2],
    ["gpt-5", 1.25, 10],
    ["gpt-4.1-nano", 0.1, 0.4],
    ["gpt-4.1-mini", 0.4, 1.6],
    ["gpt-4.1", 2, 8],
    ["gpt-4o-mini", 0.15, 0.6],
    ["gpt-4o", 2.5, 10],
    ["o4-mini", 1.1, 4.4],
    ["o3-mini", 1.1, 4.4],
    ["o3", 2, 8],
    ["gpt-3.5-turbo", 0.5, 1.5],
  ],
  anthropic: [
    ["claude-3-haiku", 0.25, 1.25],
    ["claude-3-5-haiku", 0.8, 4],
    ["claude-haiku-4-5", 1, 5],
    ["claude-sonnet-4", 3, 15],
    ["claude-opus-4-5", 5, 25],
    ["claude-opus-4-1", 15, 75],
    ["claude-opus-4-0", 15, 75],
  ],
  gemini: [
    ["gemini-2.0-flash-lite", 0.075, 0.3],
    ["gemini-2.0-flash", 0.1, 0.4],
    ["gemini-2.5-flash-lite", 0.1, 0.4],
    ["gemini-2.5-flash", 0.3, 2.5],
    ["gemini-2.5-pro", 1.25, 10],
  ],
  xai: [
    ["grok-4-1-fast", 0.2, 0.5],
    ["grok-4-fast", 0.2, 0.5],
    ["grok-code-fast", 0.2, 1.5],
    ["grok-3-mini", 0.3, 0.5],
    ["grok-3", 3, 15],
    ["grok-4", 3, 15],
  ],
};

function tierPrice(provider: AiProvider, id: string): [number, number] {
  const s = id.toLowerCase();
  switch (provider) {
    case "gemini":
      if (s.includes("lite")) return [0.1, 0.4];
      if (s.includes("flash")) return [0.3, 2.5];
      if (s.includes("pro")) return [1.25, 10];
      return [1, 8];
    case "openai":
      if (s.includes("nano")) return [0.05, 0.4];
      if (s.includes("mini")) return [0.25, 2];
      if (/^o\d/.test(s)) return [2, 8];
      return [1.25, 10];
    case "anthropic":
      if (s.includes("haiku")) return [1, 5];
      if (s.includes("opus")) return [5, 25];
      return [3, 15];
    case "xai":
      if (s.includes("mini") || s.includes("fast")) return [0.2, 0.5];
      return [3, 15];
  }
}

export function priceOf(provider: AiProvider, id: string): Price {
  let best: [string, number, number] | undefined;
  for (const row of KNOWN[provider]) {
    if (id.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  }
  if (best) return { input: best[1], output: best[2], known: true };
  const [input, output] = tierPrice(provider, id);
  return { input, output, known: false };
}

/** Estimated cost of one call, in millionths of a dollar. */
export function costMicroUsd(provider: AiProvider, model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(provider, model);
  return Math.round(p.input * inputTokens + p.output * outputTokens);
}

/** An Explain call is roughly three parts prompt to one part answer. */
function blended(p: Price): number {
  return p.input * 0.75 + p.output * 0.25;
}

function versionOf(id: string): number {
  const m = id.match(/(\d+(?:[.-]\d+)?)/);
  return m ? Number(m[1].replace("-", ".")) : 0;
}

const UNSTABLE = /preview|exp|experimental|-\d{2}-\d{2,4}$/i;

/**
 * Text models, cheapest first. Ties go to stable over preview, then to the
 * newer generation (same price, better model).
 */
export function rankModels(provider: AiProvider, ids: string[]): string[] {
  return [...new Set(ids)]
    .filter((id) => isTextModel(provider, id))
    .map((id) => ({ id, cost: blended(priceOf(provider, id)), unstable: UNSTABLE.test(id), version: versionOf(id) }))
    .sort((a, b) => a.cost - b.cost || Number(a.unstable) - Number(b.unstable) || b.version - a.version || a.id.localeCompare(b.id))
    .map((m) => m.id);
}
