# `modules/auth` — module notes

JWT-for-browsers + PAT-for-external-apps under one middleware. Single-user app; "auth" means "is this Shane or one of Shane's tokens", not multi-tenant.

## Files

- `routes.ts` — `/api/auth/google` (OAuth), `/api/auth/me`, `/api/auth/tokens` (mint + list + revoke). PAT minting requires a JWT (a PAT cannot mint another PAT — security gate, deliberate).
- `middleware.ts` — `optionalAuth`, `requireAuth`, `requireScope(scope)`, `requireAdmin()`. All populate the same Hono context vars.
- `tokens.ts` — `mintToken`, `lookupActiveToken`, `hashToken`, `listTokens`, `revokeToken`. Raw tokens are never persisted; only `tokenHash` (SHA-256 hex).
- `config.ts` — JWT secret and Google OAuth client config. Read from env.

## Context vars set on every authed request

After `optionalAuth` or `requireAuth` runs:

| `c.get(...)`     | JWT path             | PAT path               | Anonymous           |
| ---------------- | -------------------- | ---------------------- | ------------------- |
| `userId`         | the user's UUID      | the user's UUID        | `null`              |
| `tokenScopes`    | `null`               | `string[]`             | `null`              |
| `tokenId`        | `null`               | the api_tokens row id  | `null`              |

`tokenScopes === null` is the marker for "this is a JWT" — `requireScope` uses that to bypass scope checks for browser sessions. Don't change this contract without auditing every `requireScope` callsite.

`tokenId` exists so handlers and per-PAT rate limiters can identify which token a request came from. The auth context is the only place it surfaces — `c.get` it in handlers when you need to log or attribute.

## Admin gate (`requireAdmin()`)

Apply `requireAdmin()` to any route that should be Shane-only (e.g. periodic-table element writes). Contract:

- **JWT only.** PATs are explicitly rejected (`403 "browser session"`) even if the user behind the PAT is on the whitelist. Admin actions go through the browser.
- **Whitelist from env:** `ADMIN_EMAILS` is a comma-separated list of emails. The middleware lowercases + trims each. If unset or empty, every request 403s ("not configured") — safe default.
- **DB lookup per request:** the user's email is fetched from the `users` table by `userId` and compared. One extra DB round-trip per admin-gated request — fine for low-frequency admin actions.
- The current production value is `ADMIN_EMAILS=a1595042264@gmail.com` (set on Railway). To add a co-admin, append to that env var (comma-separated). No code change needed.

Order: `requireAuth, requireAdmin(), zValidator(...)` — auth first so we know the user, then admin gate, then validation. See `src/modules/elements/routes.ts` for the canonical usage.

## Allowed scopes

Defined as a const tuple in `routes.ts` (`ALLOWED_SCOPES`) so `z.enum` enforces validity. Adding a scope = append to the array AND surface it in the frontend mint dialog (`shaneFrontend/apps/shell/components/settings/mint-token-dialog.tsx`).

Current scopes:
- `entries:write` — journal entry create/edit
- `suggestions:write` — journal suggestion submit
- `comments:write` — comments
- `reactions:write` — reactions
- `knowledge:write` — POST `/api/knowledge/notes` (Nibbler-style ingest)

## PAT format and lifecycle

- Raw token: `pat_<base64url-32-bytes>`. Returned ONCE in the mint response; never persisted in raw form.
- Stored: `tokenHash` (sha256 hex), name, scopes, `lastUsedAt`, `revokedAt`, `userId`. See `db/schema.ts:apiTokens`.
- `lookupActiveToken` fires a `lastUsedAt` update on every successful lookup (fire-and-forget). That update surfaces in the `/settings/tokens` UI as "last used 2 mins ago".
- Revoke = `revokedAt` is set; `lookupActiveToken` filters by `isNull(revokedAt)`.

## Rate limiting

There's no rate limit in this module. Per-endpoint per-PAT limits live in `modules/shared/rate-limit.ts` and are wired up by the consuming route (see `modules/knowledge/routes.ts` for the canonical pattern). When adding a new write endpoint that accepts PATs, wire up a rate limiter — there's nothing blocking abuse otherwise.

## Tests

`tests/modules/auth/` covers middleware, mint/list/revoke routes, and the token hashing utilities. All use the `vi.hoisted` + mocked-drizzle pattern. Mock `db.select/update/insert` chains rather than spinning up a real DB.
