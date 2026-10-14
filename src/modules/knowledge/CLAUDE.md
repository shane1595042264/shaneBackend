# `modules/knowledge` — module notes

Free-form text → structured flashcard entries, persisted into the shared `vocabWords` table.

## What lives here

- `classifier.ts` — single LLM call that returns `ClassificationResult` (word/language/definition/...) plus an optional `source` provenance object. Pinned to `claude-haiku-4-5-20251001`; everything else flows through the shared LLM fallback chain (`modules/shared/llm.ts`).
- `routes.ts` — the public API. The interesting endpoint is `POST /notes`; the rest (`GET/POST/PUT/DELETE /entries`, `/categories`, etc.) is straightforward CRUD against `vocabWords`.
- `bilibili.ts` — fire-and-forget hook that re-publishes new entries to a Bilibili integration. Treat its return value as discardable; never `await` it in a request path.

## `POST /notes` is the only non-CRUD entry point

Three accepted request shapes (zod `union` of `.strict()` objects so `text + notes` together fails the union):

```
{ text }                          // legacy single
{ text, source }                  // single with provenance hint
{ notes: [{ text, source? }, …] } // batch (1–50)
```

`source` is `string | { app?, book?, author?, location?, rawContext? }`. Strings collapse to `{ app: <string> }`. The classifier ALSO extracts source from the text itself; in `mergeSource`, caller-supplied fields beat classifier-extracted fields per spec.

Response is always `{ entries: Entry[] }`. Partial-batch failures return `207 Multi-Status` with `failures: [{ index, text, error }]`. Total LLM-chain exhaustion returns `502`. Don't add a 409 path — cross-request dedup was deliberately removed when the Nibbler ingest contract shipped (same word from two books = two entries with different `source`).

## Recite (SHAN-575): `recite.ts` + `recite-routes.ts`

`POST /recite/deck {location, categories?}` saves the place to `practice_locations` (upsert, the list practice mode uses) and returns the caller's cards (created by them, or legacy ownerless) that have a definition and are NOT memorized there, `ORDER BY random()`, plus per-category `{total, remaining}`. `POST /entries/:id/recite {location, answer, attempt}` grades the typed definition; a pass appends the saved location's canonical name to `memorization_locations` under the same `FOR UPDATE` lock as `PUT /entries/:id` and practice's vocab SRS, a miss writes nothing and returns `hints[attempt-1]` (example or topics, opening words, word shapes).

- Grading order: near-verbatim (normalized Levenshtein >= 92%) passes with no model call; then `generateSmallText` (Groq gpt-oss-20b first, JSON mode, low reasoning); then local MiniLM cosine >= 0.78. Only when the local model also fails does the route 503.
- The prompt grades "defining facts", not "every fact". An every-fact prompt failed a correct dmesg paraphrase that left out "or controls" (measured on prod cards).
- **Miss feedback is filtered, not trusted.** The model names the missing content despite being told not to ("It does not mention the kernel ring buffer"); `feedbackLeaks` replaces any miss feedback containing a reference content word the learner did not type. Hints are the only sanctioned way to give the answer away.

## Auth contract

- Requires either a JWT (browser cookie/localStorage path) or a PAT with the `knowledge:write` scope. Anonymous → 401.
- JWTs bypass scope checks (the existing convention in `modules/auth/middleware.ts`).
- Per-PAT rate limit: 30/min single, 5/min batch, separate buckets. JWTs bypass.
- `c.get("tokenId")` is set in middleware and logged per-request — useful for tracing which client ingested what.

## Classifier gotchas

- The prompt is in `classifier.ts` as a template literal — there's no escaping of newlines/backticks in the user text, only double-quotes. Theoretical prompt-injection risk; treat the model's output as untrusted and never feed it back into another prompt without revalidation. Acceptable for a single-user personal app, flag if surface area widens.
- The catch-all fallback returns a generic `general`-category entry with the full input as `definition`. That can be a 5000-char blob; if that ever shows up in the UI looking ugly, truncate in the fallback rather than relying on the model.
- The model is told to return `source: null` when the text has no provenance. If it returns a partially-populated object with everything null (rare), the route's `mergeSource` collapses that to `null` instead of saving an all-null record.

## DB notes

- `vocabWords.source` is `jsonb`, nullable, no default — existing rows are `null` because they predate the column.
- Per top-level CLAUDE.md, `drizzle-kit push --force` on startup CAN silently no-op when adding a column (SHAN-159). When pushing a schema change here, verify with `bun scripts/add-source-column.ts` style scripts or psql, and ALTER manually if the column never landed. This bit us on the original 2026-05-16 ship.

## Tests

`tests/modules/knowledge/` mocks `@/modules/shared/llm` so no real LLM calls — see `classifier.test.ts` and `notes-routes.test.ts` for the pattern. Both follow the `vi.hoisted` + mocked-drizzle pattern used everywhere else in this repo.
