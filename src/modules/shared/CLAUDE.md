# `modules/shared` — module notes

Cross-cutting utilities. Each file should have one well-defined contract and no domain knowledge.

## `llm.ts` — `generateText`

The single chokepoint for every LLM call in the backend. Provider fallback chain (in order):

1. **Anthropic** — passed `model` (callers pin to Haiku 4.5 for cheap classification or Sonnet 4 for richer prompts). Default model is `claude-sonnet-4-20250514`.
2. **Google Gemini** — `gemini-2.0-flash` → `gemini-2.0-flash-lite`. Requires `GOOGLE_AI_API_KEY`. Free tier with daily quota.
3. **Groq Llama** — `llama-3.3-70b-versatile` → `llama-3.1-8b-instant`. Requires `GROQ_API_KEY`. Free tier with per-minute rate limits and retry-after handling baked in.

If every provider in the chain fails, throws:

```
new Error(`All LLM providers failed. Anthropic: ${anthropicError}; Groq: ${groqError}`);
```

Callers that want HTTP 502-on-exhaustion semantics match on `err.message.includes("All LLM providers failed")` — see `modules/knowledge/routes.ts` for the canonical pattern. Don't restructure this error message without updating those matchers.

`generateText` returns `{ text, modelUsed, usage }`. The `modelUsed` is the actual provider/model that succeeded — log it (or surface it in observability) so you can tell when fallbacks are kicking in.

Pass `noFallback: true` to bypass the chain and throw on Anthropic failure directly. Useful for tests or when you specifically need Anthropic and don't want a different model's output to silently take over.

## `rate-limit.ts` — `createPATRateLimit`

Per-PAT, per-bucket, in-memory rolling 60s rate limiter. Factory takes `{ bucket, limitPerMinute }` and returns a Hono middleware.

Three things to know:

- **JWTs pass through uncounted.** The middleware only counts when `c.get("tokenId")` is non-null. Set `tokenId` in auth middleware first (PATs only).
- **Bucket lookup happens per request, not at factory time.** This is deliberate — `__resetRateLimitBuckets()` clears state between tests, and capturing the inner Map in a closure would orphan it. If you change this, make sure tests still isolate cleanly across files.
- **In-memory only.** Single Railway instance restart resets all counters. If the deployment ever goes horizontally multi-instance, this becomes broken — swap to Postgres-backed counters before scaling out.

Two endpoints can share a token's quota or have separate quotas depending on bucket name. The knowledge ingest endpoint runs single-shape and batch-shape limiters off different bucket names so a flurry of single-note posts doesn't lock out a batch sync.

## `embeddings.ts` (if present)

Local embeddings via `@xenova/transformers`. CPU-only, no API key. Slow but free; used for pgvector similarity searches in the knowledge module. Don't try to wire this through `generateText` — it's not text generation.

## Pattern for adding a new shared util

If you find yourself wanting to import code from one feature module into another, that code probably belongs here. Keep each file under ~200 lines and export only what callers need. Tests live in `tests/modules/shared/<name>.test.ts` and follow the `vi.hoisted` mocking pattern used elsewhere in the repo.
