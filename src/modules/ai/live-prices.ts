// SHAN-703: list prices pulled from a maintained public price file, refreshed
// daily, so a provider's price change shows up in Usage within a day instead
// of whenever someone edits catalog.ts.
//
// No provider publishes a pricing API, and their responses carry token counts,
// never cost. LiteLLM's model_prices_and_context_window.json is the closest
// thing to one: maintained by the LiteLLM project, updated within days of a
// price change, and keyed by the exact model ids the providers' own APIs
// return (Gemini and xAI behind a "gemini/" or "xai/" prefix). It agrees with
// OpenRouter's /api/v1/models on every model we use (checked 2026-11-17).
//
// The snapshot lives in memory. A boot fetches it; the scheduler re-fetches
// once it is a day old and retries hourly while it is missing or stale. When
// it cannot be had, catalog.ts falls back to its built-in table, then to tier
// guesses, exactly as before this file existed.

import type { AiProvider } from "./detect";

export const LIVE_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** A day, give or take the hourly check that notices it. */
export const LIVE_PRICES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Fewer models than this means a truncated or wrong file; keep what we had. */
const MIN_MODELS = 50;

/** USD per million tokens. */
export interface PricePair {
  input: number;
  output: number;
}

type PriceTable = Map<AiProvider, Map<string, PricePair>>;

let snapshot: { prices: PriceTable; fetchedAt: Date; count: number } | null = null;
let inFlight: Promise<boolean> | null = null;

const PROVIDERS: Record<string, AiProvider> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gemini",
  xai: "xai",
};

/**
 * The price file, reduced to first-party chat models. Entries for the same
 * model sold through Bedrock, Vertex, Azure and resellers carry other
 * `litellm_provider` values and are skipped: a reader's key is always the
 * provider's own.
 */
export function parseLiteLlmPrices(json: unknown): PriceTable {
  const table: PriceTable = new Map();
  if (!json || typeof json !== "object") return table;
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const provider = PROVIDERS[String(v.litellm_provider)];
    if (!provider || v.mode !== "chat") continue;
    const input = v.input_cost_per_token;
    const output = v.output_cost_per_token;
    if (typeof input !== "number" || typeof output !== "number") continue;
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    // Gemini and xAI models are listed as "gemini/<id>" and "xai/<id>";
    // OpenAI and Anthropic ones bare. A slash anywhere else ("openai/container")
    // is a LiteLLM route, not a model id a provider lists.
    const prefix = provider === "gemini" || provider === "xai" ? `${v.litellm_provider}/` : "";
    const id = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
    if (!id || id.includes("/") || id === "sample_spec") continue;
    let byId = table.get(provider);
    if (!byId) table.set(provider, (byId = new Map()));
    // Per token in the file, per million here, rounded off float noise
    // (1.0000000000000001e-07 * 1e6).
    byId.set(id, { input: round(input * 1e6), output: round(output * 1e6) });
  }
  return table;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function countOf(table: PriceTable): number {
  let n = 0;
  for (const byId of table.values()) n += byId.size;
  return n;
}

/**
 * Fetch and swap in a new snapshot. Never throws: a failure leaves the last
 * good snapshot (or none) in place and returns false. Concurrent callers share
 * one request.
 */
export function refreshLivePrices(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchImpl(LIVE_PRICES_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const prices = parseLiteLlmPrices(await res.json());
      const count = countOf(prices);
      if (count < MIN_MODELS) throw new Error(`only ${count} first-party chat models in the file`);
      snapshot = { prices, fetchedAt: new Date(), count };
      console.log(`[ai] live prices refreshed: ${count} models`);
      return true;
    } catch (err) {
      console.warn("[ai] live price refresh failed, keeping the previous prices:", (err as Error).message);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Refresh only when there is no snapshot or it is a day old. */
export function refreshLivePricesIfStale(now = Date.now()): Promise<boolean> {
  if (snapshot && now - snapshot.fetchedAt.getTime() < LIVE_PRICES_MAX_AGE_MS) return Promise.resolve(true);
  return refreshLivePrices();
}

/**
 * The live price for a model id: an exact match, else the longest listed id
 * the given one extends at a "-" or "@" boundary, so a dated
 * "claude-haiku-5-5-20261001" finds "claude-haiku-5-5" but "gpt-5.5" never
 * takes "gpt-5"'s price.
 */
export function livePriceOf(provider: AiProvider, id: string): PricePair | null {
  const byId = snapshot?.prices.get(provider);
  if (!byId) return null;
  const exact = byId.get(id);
  if (exact) return exact;
  let best: string | null = null;
  for (const key of byId.keys()) {
    if (key.length >= id.length || !id.startsWith(key)) continue;
    const next = id[key.length];
    if (next !== "-" && next !== "@") continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? byId.get(best)! : null;
}

export interface LivePricesStatus {
  /** "live" while a snapshot is loaded, "builtin" when costs come from catalog.ts. */
  source: "live" | "builtin";
  updatedAt: string | null;
  models: number;
}

export function livePricesStatus(): LivePricesStatus {
  return snapshot
    ? { source: "live", updatedAt: snapshot.fetchedAt.toISOString(), models: snapshot.count }
    : { source: "builtin", updatedAt: null, models: 0 };
}

/** Tests only. */
export function __setLivePricesForTest(table: PriceTable | null, fetchedAt = new Date()): void {
  snapshot = table ? { prices: table, fetchedAt, count: countOf(table) } : null;
}
