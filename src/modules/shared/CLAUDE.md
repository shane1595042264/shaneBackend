# `modules/shared` — module notes

Cross-cutting utilities. Each file should have one well-defined contract and no domain knowledge.

## `llm.ts` — `generateText`

The single chokepoint for every LLM call in the backend. Provider fallback chain (in order):

1. **Anthropic** — passed `model` (callers pin to Haiku 4.5 for cheap classification or Sonnet 4 for richer prompts). Default model is `claude-sonnet-4-20250514`.
2. **Google Gemini** — `gemini-3.6-flash` (the 2.0 models were retired by Google in 2026-08, SHAN-437). Requires `GOOGLE_AI_API_KEY`. Free tier with daily quota. Thinking model: llm.ts joins non-thought parts and treats an empty answer as a failure so the chain continues.
3. **Groq** — `openai/gpt-oss-120b` → `openai/gpt-oss-20b` (the llama models were retired by Groq in 2026-08, SHAN-437). Requires `GROQ_API_KEY`. Free tier with per-minute rate limits and retry-after handling baked in.

### Transient failures vs. real ones (SHAN-527)

Every provider call is bounded by `PROVIDER_TIMEOUT_MS` (60s) — `AbortSignal.timeout` on the two raw `fetch` call sites and the `timeout` option on the Anthropic client. Neither Bun nor undici applies a default request timeout and the Anthropic SDK's own default is 10 minutes, so without this a provider that accepts the connection and then goes quiet wedges the caller (an HTTP handler or a cron job) indefinitely. 60s is deliberately looser than the 10s the HTML scrapers use because Gemini 3.x burns hidden thinking tokens before its first visible one.

Gemini failures are triaged rather than treated alike, because with the Anthropic account out of credits Gemini is in practice the *primary* provider and dropping it demotes every classification to a free-tier `gpt-oss` model:

- **5xx, or the request never landing (timeout / dropped connection)** — the model is momentarily overloaded, which is Gemini's most common failure and clears on its own. Retried in place up to `GEMINI_MAX_ATTEMPTS` (3) with exponential backoff from `GEMINI_RETRY_BASE_MS` (400ms), so attempts land at t=0, +400ms, +800ms.
- **429 / `quota`** — the free-tier allowance is gone and no amount of backoff brings a daily quota back. Moves to the next model in the list, then falls through to Groq. Never retried in place.
- **Anything else (400, a retired model 404, an empty answer)** — about the request we sent, not the provider's mood. Falls through immediately; retrying only adds latency.

Retry classification reads `ProviderHttpError.status`, not a regex over the message, because provider error bodies contain digits of their own. `ProviderNetworkError` wraps *only* the `fetch` call, so a bug in our own response parsing can never be mistaken for a flaky network and retried three times.

If every provider in the chain fails, throws:

```
new Error(`All LLM providers failed. Anthropic: ${anthropicError}; Gemini: ${geminiError}; Groq: ${groqError}`);
```

Callers that want HTTP 502-on-exhaustion semantics match on `err.message.includes("All LLM providers failed")` — see `modules/knowledge/routes.ts` for the canonical pattern. Don't restructure this error message without updating those matchers; the prefix is load-bearing in `knowledge/routes.ts` (x2), `vocabulary/routes.ts` and `trip-groups/routes.ts`, and `tests/app-admin-error-sanitization.test.ts` asserts the whole string is scrubbed before it reaches a client (these errors embed upstream bodies, including API keys — log them server-side only, per SHAN-351).

`generateText` returns `{ text, modelUsed, usage }`. The `modelUsed` is the actual provider/model that succeeded — log it (or surface it in observability) so you can tell when fallbacks are kicking in.

Pass `noFallback: true` to bypass the chain and throw on Anthropic failure directly. Useful for tests or when you specifically need Anthropic and don't want a different model's output to silently take over.

## `rate-limit.ts` — `createPATRateLimit`

Per-PAT, per-bucket, in-memory rolling 60s rate limiter. Factory takes `{ bucket, limitPerMinute }` and returns a Hono middleware.

Three things to know:

- **JWTs pass through uncounted.** The middleware only counts when `c.get("tokenId")` is non-null. Set `tokenId` in auth middleware first (PATs only).
- **Bucket lookup happens per request, not at factory time.** This is deliberate — `__resetRateLimitBuckets()` clears state between tests, and capturing the inner Map in a closure would orphan it. If you change this, make sure tests still isolate cleanly across files.
- **In-memory only.** Single Railway instance restart resets all counters. If the deployment ever goes horizontally multi-instance, this becomes broken — swap to Postgres-backed counters before scaling out.

Two endpoints can share a token's quota or have separate quotas depending on bucket name. The knowledge ingest endpoint runs single-shape and batch-shape limiters off different bucket names so a flurry of single-note posts doesn't lock out a batch sync.

## `zod-validator.ts` — `zValidator`

Drop-in replacement for `@hono/zod-validator`'s `zValidator`. **Import it from here, never from `@hono/zod-validator` directly.** Upstream's default failure response is the raw ZodError dump (`{"success":false,"error":{"issues":[...]}}`), which has no top-level `error` string and contradicts the `{ error }` shape `http-errors.ts` enforces everywhere else. This wrapper injects a default hook that returns 400 `{ error: "Validation failed: <summary>", details: [{ path?, message }] }` (SHAN-451).

- A call site can still pass its own hook as the 3rd arg; the default only applies when none is given.
- `path` is the dot-joined zod path and is omitted for object-level errors, so clients can key form fields off it.
- The `error` summary folds the first 5 issues and appends `(+N more)`; `details` is never truncated.
- The public contract is documented in the frontend docs element (`lib/docs/content/conventions.ts`) — change one, change the other.

## `conditional-get.ts` — `conditionalGet`

Global middleware (registered in `app.ts` right after `cors`) that gives every 200 JSON GET a weak `ETag` plus `Cache-Control: private, no-cache`, and turns a matching `If-None-Match` into a bodiless 304 (SHAN-455).

- **Weak tags on purpose.** Railway's edge proxy applies gzip, not this server, so one handler output is served as two representations. A strong tag would claim byte equality we cannot promise; `If-None-Match` compares weakly anyway.
- **Handlers win.** If a route already set `ETag` the middleware skips it entirely; if it already set `Cache-Control` (the immutable image routes do) that value is kept.
- **Register it after `cors`, never before.** `hono/cors` writes its headers onto the response *before* calling the next middleware, so running after it is what puts those headers within reach when this one rebuilds the response. Move it above `cors` and every 304 becomes unreadable to a browser.
- **The 304 path copies everything except the body-describing headers** (`Content-Type`, `Content-Length`, `Content-Encoding`, ...), then clears the old response's headers before swapping `c.res`. Hono's `res` setter copies the previous response's headers onto the new one, so without that clear they would come straight back onto a bodiless reply.
- The public contract is documented in the frontend docs element (`lib/docs/content/conventions.ts`) — change one, change the other.

## `if-match.ts` — `readIfMatch`

Reads the optimistic-concurrency version off a request, accepting `If-Match` or `X-If-Match`, `If-Match` winning if both are sent. Every handler that gates a write on a version number must call this instead of reading the header directly — journal revert, journal suggestion approve, blog body-edit and blog revert all do.

- **Why the alias.** Browser writes are same-origin and ride the rewrite through Vercel's edge (SHAN-458), which evaluates a real `If-Match` against the response `ETag`. `conditional-get.ts` tags every 200 JSON response with a **weak** validator, and a weak validator can never satisfy `If-Match`, which requires strong comparison. The edge therefore replaced the origin's 200 with a `412` *after* the write committed: the client reported a failure on a save that had landed, and the retry duplicated it (SHAN-487 on the blog, SHAN-489 on the journal).
- **Only the successes break**, which is what hid it for so long — the 409 and 428 paths carry no `ETag`, so the conflict flows looked perfect.
- **`If-Match` remains the documented header** for direct callers (a PAT plus curl against the Railway origin); `X-If-Match` exists for browsers, and both are in the `allowHeaders` list in `app.ts`.

## `keyset.ts` — `encodeKeysetCursor` / `parseKeysetCursor` / `keysetCursorParam` / `keysetBefore`

Compound cursors for the newest-first list endpoints (SHAN-513). Every list that keysets on a timestamp must use these instead of hand-rolling `lt(createdAt, new Date(cursor))`.

- **Why the id half exists.** The old predicate was `lt(createdAt, cursor)` under `orderBy(desc(createdAt))` with no tiebreaker, which drops rows two ways. Tied timestamps: `createdAt` is not unique, so when two rows share one and it ends a page, the strict `lt` excludes the tied sibling from every later page. Postgres `now()` is transaction-start time, so anything written in one transaction ties exactly. Truncation: the column is microsecond-precision but the pg driver parses it into a millisecond-precision JS `Date`, so a cursor built from it lands *before* the boundary row's real value and swallows anything in that gap. Measured on prod: `2026-05-24 21:32:37.48453+00` emits as `...:37.484Z`, a 530μs blind spot.
- **`keysetBefore` compares against the stored key, not the cursor's copy of it.** `(ts, id) < (coalesce((select k.<ts> from <table> k where k.id = $1::uuid), $2::timestamptz), $3::uuid)`. The subquery is what restores full precision; the alias `k` is what keeps its `from` from correlating with the outer query. The `coalesce` is the degradation path — a boundary row deleted between pages would otherwise make the comparison NULL and end pagination early.
- **Pair it with `orderBy(desc(ts), desc(id))`.** The predicate and the sort have to agree or pages overlap. This is the easy half to forget.
- **Legacy cursors still work.** A bare ISO string parses to `{ ts, id: null }` and takes the old `lt` path, so cursors in flight across a deploy keep working. Only newly emitted ones carry the id.
- **Identifiers come from the passed columns at call time** via `getTableName` + `sql.identifier`. Don't hoist them to module scope: a top-level `table.col` throws under the partial `@/db/schema` mocks the route tests use.
- Unit tests compile the real SQL with `PgDialect`, and `scripts/keyset-dryrun.ts` runs the composed predicate against the real database in a rolled-back transaction — the mocked-drizzle tests cannot tell you the SQL is valid.
- The public contract is documented in the frontend docs element (`lib/docs/content/conventions.ts`) — change one, change the other.

## `domain-errors.ts` — `VersionNotFoundError` / `SuggestionNotPendingError`

Typed errors a repo throws and a route maps to a status code (SHAN-530). Two
of them today:

- **`VersionNotFoundError`** — `revertToVersion` on both the journal and the
  blog, when `target_version_num` names a version the record does not have.
  Both revert handlers answer `404 { error: "Target version not found" }`.
- **`SuggestionNotPendingError(currentStatus)`** — `approveSuggestion` /
  `rejectSuggestion`, when the suggestion was decided between the route's read
  and the transaction's re-read. 409 with `currentStatus`, or 404 when
  `currentStatus` is null (the row is gone).

**Why they live in `shared` and not next to the repo that throws them.** Every
journal/blog route test partially mocks the repo module
(`vi.mock("@/modules/journal/versions-repo", () => ({ ... }))`). A class
exported from the repo is `undefined` under such a mock unless each factory
remembers to restate it, and `err instanceof undefined` throws a TypeError
*from inside the catch block* — a worse bug than the mapping gap it was meant
to fix, and one that only shows up at request time. Twelve test files mock
those two repos today; nothing mocks `shared`. `VersionConflictError` predates
this file and stays duplicated in each `versions-repo`, because the route tests
already restate it by hand.

The rule this generalizes: if a route's `catch` needs `instanceof`, the class
belongs somewhere the route tests do not mock. Matching on `err.message`
instead (what the blog revert handler did before SHAN-530) survives the mocks
but silently stops working the moment someone rewords the string.

## `embeddings.ts` (if present)

Local embeddings via `@xenova/transformers`. CPU-only, no API key. Slow but free; used for pgvector similarity searches in the knowledge module. Don't try to wire this through `generateText` — it's not text generation.

## Pattern for adding a new shared util

If you find yourself wanting to import code from one feature module into another, that code probably belongs here. Keep each file under ~200 lines and export only what callers need. Tests live in `tests/modules/shared/<name>.test.ts` and follow the `vi.hoisted` mocking pattern used elsewhere in the repo.
