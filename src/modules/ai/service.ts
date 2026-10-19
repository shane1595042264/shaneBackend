// SHAN-596: the two things the AI routes actually do. Adding a key (detect,
// list, find the cheapest model that really answers, seal, store) and
// explaining a selection (pick the key and model, build the prompt, call,
// record what it cost).

import { costMicroUsd, rankModels } from "./catalog";
import { openKey, sealKey } from "./crypto";
import { AI_PROVIDERS, detectProvider, keyHint, type AiProvider } from "./detect";
import { ProviderError, generate, listModels } from "./providers";
import * as repo from "./repo";

/** How many models the key check will try before giving up on a key. */
const MAX_PROBES = 4;

export class KeyCheckError extends Error {
  constructor(
    readonly code: "unknown_provider" | "auth" | "quota" | "no_models" | "unreachable",
    message: string
  ) {
    super(message);
    this.name = "KeyCheckError";
  }
}

/**
 * Proves a key works by spending one output token on the cheapest text model
 * it can list, falling through to the next cheapest when a model is listed
 * but refused (retired for new users, not on this tier). "Valid" alone is not
 * the bar: a key whose account has no credit lists models happily and fails
 * every real call, and that is the case worth catching while the reader is
 * still on the settings page.
 */
export async function checkKey(provider: AiProvider, key: string, userId: string) {
  let listed: string[];
  try {
    listed = await listModels(provider, key);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "auth") {
      throw new KeyCheckError("auth", `The provider rejected this key: ${err.message}`);
    }
    throw new KeyCheckError("unreachable", err instanceof Error ? err.message : "Could not reach the provider");
  }
  const models = rankModels(provider, listed);
  if (models.length === 0) throw new KeyCheckError("no_models", "This key cannot use any text model.");

  let lastError: ProviderError | null = null;
  for (const model of models.slice(0, MAX_PROBES)) {
    try {
      const r = await generate(provider, key, model, { system: "Reply with one word.", prompt: "ok", maxTokens: 8 });
      await repo.recordUsage({
        userId,
        provider,
        model,
        feature: "validate",
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicroUsd: costMicroUsd(provider, model, r.inputTokens, r.outputTokens),
      });
      return { models, defaultModel: model };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      lastError = err;
      if (err.kind === "auth") throw new KeyCheckError("auth", `The provider rejected this key: ${err.message}`);
      if (err.kind === "quota") {
        throw new KeyCheckError("quota", `The key is valid but the account cannot run models: ${err.message}`);
      }
      // "model", "rate", "other": try the next model.
    }
  }
  throw new KeyCheckError(
    "no_models",
    `None of the cheapest models answered${lastError ? `: ${lastError.message}` : "."}`
  );
}

export async function addKey(userId: string, rawKey: string) {
  const key = rawKey.trim();
  const detection = detectProvider(key);
  if (!detection.provider) throw new KeyCheckError("unknown_provider", detection.reason);
  const { models, defaultModel } = await checkKey(detection.provider, key, userId);
  return repo.upsertKey({
    userId,
    provider: detection.provider,
    keySealed: sealKey(key),
    keyHint: keyHint(key),
    models,
    defaultModel,
  });
}

/**
 * The result is written only if the row still holds the key that was checked:
 * the check can take several provider calls, and a key added for the same
 * provider meanwhile replaces this one in place. Then the reader gets the row
 * as it is now, untouched.
 */
export async function recheckKey(userId: string, id: string) {
  const row = await repo.getKey(userId, id);
  if (!row) return null;
  let updated: repo.KeyRow | null;
  try {
    const { models, defaultModel } = await checkKey(row.provider as AiProvider, openKey(row.keySealed), userId);
    const keepPreferred = row.preferredModel && models.includes(row.preferredModel) ? row.preferredModel : null;
    updated = await repo.updateKey(
      userId,
      id,
      { models, defaultModel, preferredModel: keepPreferred, status: "ok", lastError: null, lastCheckedAt: new Date() },
      row.keySealed
    );
  } catch (err) {
    updated = await repo.updateKey(
      userId,
      id,
      { status: "failing", lastError: err instanceof Error ? err.message : "Check failed", lastCheckedAt: new Date() },
      row.keySealed
    );
  }
  return updated ?? repo.getKey(userId, id);
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

export interface ExplainInput {
  quote: string;
  before: string;
  after: string;
  title?: string;
  heading?: string;
  surface: "journal" | "blog" | "knowledge";
}

/**
 * The fixed prompt. The reader never types one: the selection is the
 * question, and the surrounding words (about 120 before and 80 after, chosen
 * by the client) say which sense of it applies. The document title and the
 * nearest heading are there for topic, since a paragraph alone can be
 * ambiguous about what field it is in.
 */
export function buildExplainPrompt(input: ExplainInput) {
  const system = [
    "You explain a highlighted word or passage to someone reading a document.",
    "Use the surrounding text to work out which meaning applies here, and explain that meaning.",
    "Answer in two to four plain sentences. If it helps, end with one short example.",
    "Write in the language of the surrounding text. No preamble, no heading, do not restate the question.",
    "Do not use em dashes.",
  ].join(" ");
  const lines = [
    input.title ? `Document: ${input.title}` : null,
    input.heading ? `Section: ${input.heading}` : null,
    `Text before: ...${input.before}`,
    `Highlighted: <<${input.quote}>>`,
    `Text after: ${input.after}...`,
    "",
    "Explain the highlighted text as it is used here.",
  ].filter((l): l is string => l !== null);
  return { system, prompt: lines.join("\n") };
}

export class ExplainError extends Error {
  constructor(
    readonly code: "no_key" | "provider",
    message: string,
    readonly kind?: string
  ) {
    super(message);
    this.name = "ExplainError";
  }
}

/**
 * The reader's preferred provider when it has a working key, otherwise the
 * first working key they added. The model is the one they picked for that key,
 * otherwise the cheapest one that passed the key check.
 */
export function chooseKey(keys: repo.KeyRow[], settings: repo.AiSettings): repo.KeyRow | null {
  const usable = keys.filter((k) => k.status === "ok" && (AI_PROVIDERS as string[]).includes(k.provider));
  return usable.find((k) => k.provider === settings.preferredProvider) ?? usable[0] ?? null;
}

export async function explain(userId: string, input: ExplainInput) {
  const [keys, settings] = await Promise.all([repo.listKeys(userId), repo.getSettings(userId)]);
  const row = chooseKey(keys, settings);
  if (!row) throw new ExplainError("no_key", "Add an AI key in Settings to use Explain.");
  const provider = row.provider as AiProvider;
  const model = row.preferredModel ?? row.defaultModel;

  let key: string;
  try {
    key = openKey(row.keySealed);
  } catch {
    await repo.updateKey(
      userId,
      row.id,
      { status: "failing", lastError: "Stored key could not be read. Add it again." },
      row.keySealed
    );
    throw new ExplainError("no_key", "Your saved key could not be read. Add it again in Settings.");
  }

  const { system, prompt } = buildExplainPrompt(input);
  try {
    const r = await generate(provider, key, model, { system, prompt, maxTokens: 400 });
    const cost = costMicroUsd(provider, model, r.inputTokens, r.outputTokens);
    await repo.recordUsage({
      userId,
      provider,
      model,
      feature: "explain",
      surface: input.surface,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costMicroUsd: cost,
    });
    const explanation = r.text.replace(/\s*[—–]\s*/g, ", ").trim();
    if (!explanation) throw new ExplainError("provider", "The model returned an empty answer. Try again.", "other");
    return {
      explanation,
      provider,
      model,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costMicroUsd: cost },
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      // Only the key that was refused: a working key pasted in while this
      // call was out keeps its "ok".
      if (err.kind === "auth" || err.kind === "quota") {
        await repo.updateKey(userId, row.id, { status: "failing", lastError: err.message }, row.keySealed);
      }
      throw new ExplainError("provider", err.message, err.kind);
    }
    throw err;
  }
}
