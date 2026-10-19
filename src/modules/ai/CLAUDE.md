# `modules/ai` — bring-your-own-key AI (SHAN-596)

Readers paste their own provider key in Settings > AI; Explain (and only Explain) runs on it. The server's own keys in `modules/shared/llm.ts` are never used for a reader's request and a reader's key is never used for anything else.

## Files

- `detect.ts` — provider from key format. Order matters: `sk-ant-` before `sk-`, `sk-or-` (OpenRouter) and `gsk_` (Groq) are named and refused. Supported: `AIza` + 35 (Gemini), `sk-` (OpenAI), `sk-ant-` (Anthropic), `xai-` (xAI Grok).
- `catalog.ts` — `isTextModel` (Gemini's list is mostly TTS/image/music/agents), list prices where known, tier estimates by name otherwise, `rankModels` cheapest first.
- `providers.ts` — `listModels` / `generate` for the four providers, 25s deadline, every failure a `ProviderError` with `kind` auth | quota | model | rate | other.
- `crypto.ts` — AES-256-GCM sealing. **The data key is HKDF(JWT_SECRET).** Rotating `JWT_SECRET` makes every stored AI key unreadable; `explain` then marks the key failing and asks the reader to add it again. No other secret to provision.
- `service.ts` — `checkKey` (list, rank, then spend one token on models cheapest-first until one answers: a listed model can still be refused, e.g. `gemini-2.5-flash-lite` 404s "no longer available to new users"), `addKey`, `recheckKey`, `explain` + `buildExplainPrompt` + `chooseKey`.
- `repo.ts` — `user_ai_keys` (one per provider per user, upsert replaces), `user_ai_settings` (preferred provider, notesToKnowledge default true), `ai_usage_events` (every call, cost in micro-USD).
- `note-schemas.ts` — the anchor and `meta` ({kind:"ai", provider, model}) shapes shared by journal notes and `modules/reader-notes`.

## Rules

- Every `/api/ai` route is `requireAuth` + `requireBrowserSession`: a PAT can neither see which keys exist nor spend from one.
- The sealed key never leaves the server; `publicKey()` is the only shape returned.
- Model choice: preferred provider's key if it is `ok`, else the first `ok` key; that key's `preferredModel`, else `defaultModel` (the cheapest model that passed the check).
- An auth or quota refusal during `explain` flips the key to `failing` so the next Explain does not hit the same wall; `POST /keys/:id/check` re-runs the check.
- Any key write decided about a key you read earlier (recheck result, Explain's `failing`, a preferred model checked against `models`) passes that row's `keySealed` to `updateKey`: re-adding a provider's key replaces it under the same id, so an unguarded write lands on the new key (SHAN-600). Likewise `saveSettings` writes only the fields sent; never merge into a read and write the whole row back.
- Explain answers are stripped of em/en dashes before they are returned (house rule).
- The explanation is saved as a note by the client (journal comment or reader note, with `meta`), not here. That note is the cache: the client looks for an AI note on the same quote before calling Explain again.

## Measured (2026-10-18, server keys)

Explaining "ring buffer" with ~40 words of context: `gemini-3.5-flash-lite` 783 ms, 148 in / 81 out, ~$0.00005; `claude-haiku-5-5` 1076 ms, 230 / 99, ~$0.0007.
