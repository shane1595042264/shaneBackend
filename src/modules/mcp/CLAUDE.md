# `modules/mcp` — MCP server (SHAN-704)

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP, so Claude Code (or any MCP client) can use the site as tools. Reach it as `https://shanejli.com/api/mcp` (the frontend's `/api` rewrite; the Railway origin works too but is blocked on the PMG network).

## Shape

- **Stateless, tools only, JSON responses.** Every message is one POST; answers are `application/json` (the transport allows that instead of SSE), notifications get 202 with no body, `GET`/`DELETE` are 405. No `Mcp-Session-Id`, so any instance answers anything. Small enough that `protocol.ts` implements it directly; there is no SDK dependency.
- **Versions:** `initialize` echoes a requested version from `SUPPORTED_PROTOCOL_VERSIONS`, else answers `LATEST_PROTOCOL_VERSION`. Batches (dropped from the spec in 2025-06-18) are still answered, max 20.
- **Auth:** `requireAuth` on the route, so `Authorization: Bearer <PAT>` (or a browser JWT). A 401 carries `WWW-Authenticate: Bearer`. A cross-site browser `Origin` is 403 (the spec's DNS-rebinding rule); native clients send none.

## Tools never touch the database

Each tool in `tools.ts` builds one ordinary API request and the route replays it in-process through `app.fetch` (the `dispatch` passed in `app.ts`), with the caller's own `Authorization` header. So scopes, ownership, journal membership, zod validation and per-PAT rate limits apply exactly as over HTTP, and this module grants nothing the token could not already do. When you add a tool, add a route call, not a query.

- Typed tools: `whoami`, `knowledge_add_note`, `knowledge_search`, `knowledge_get`, `journal_list`, `journal_get`, `journal_create`, `journal_append`, `blog_list`, `blog_get`.
- `read_docs` fetches `https://shanejli.com/docs/raw/<slug>` (or `/llms.txt`), cached 10 minutes. `DOCS_ORIGIN` overrides the origin.
- `api_get` / `api_write` reach any `/api/...` path. Reads and writes are separate tools so a client can auto-allow the read-only one. Two locks keep them inside `/api` and off `/api/mcp`: the `API_PATH` pattern refuses `.`/`..` segments (and `%2e` spellings, which URL parsing resolves), and `buildUrl` re-checks the normalized path before dispatch. Keep both.
- `inputSchema` is the single source of truth: published as-is in `tools/list` and enforced by `schema.ts`'s `validate` on `tools/call`. Bad arguments come back as a tool result with `isError`, not a JSON-RPC error, so the model can fix the call.
- A non-2xx answer becomes `isError` with `HTTP <status>` and the body. Results over `MAX_RESULT_CHARS` (60k) are truncated with a note telling the model to narrow the request.

## Connecting Claude Code

```bash
claude mcp add --transport http --scope user shanejli https://shanejli.com/api/mcp --header "Authorization: Bearer pat_..."
```

Mint the PAT at shanejli.com/settings/tokens with the scopes the agent should have; the tools can do exactly what the token can.
