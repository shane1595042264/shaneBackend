// SHAN-704: the MCP tools. Every tool is a thin wrapper over a route that
// already exists: it builds one API request and replays it in-process with
// the caller's own Authorization header, so scopes, ownership, journal
// membership, validation and per-PAT rate limits all apply exactly as they do
// over HTTP. Nothing here reads or writes the database itself.

import type { JsonSchema } from "./schema";

export interface ApiCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  ifMatch?: string | number;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ToolContext {
  call(req: ApiCall): Promise<ApiResult>;
  /** Raw markdown of a docs page, or the llms.txt index when slug is omitted. */
  docs(slug?: string): Promise<{ status: number; text: string }>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Long enough for a full journal entry with its appends; short enough not to flood a context window. */
export const MAX_RESULT_CHARS = 60_000;

export function textResult(text: string, isError = false): ToolResult {
  const clipped =
    text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters. Narrow the request with limit, filters or a cursor.]`
      : text;
  return isError ? { content: [{ type: "text", text: clipped }], isError: true } : { content: [{ type: "text", text: clipped }] };
}

/** A route's answer as a tool result: the JSON body, and the status when it is not a success. */
export function apiResult(res: ApiResult): ToolResult {
  if (res.status === 204) return textResult("HTTP 204: done, no content.");
  const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
  if (res.status >= 400) return textResult(`HTTP ${res.status}\n${body}`, true);
  return textResult(body);
}

// Paths the generic tools may reach: anything under /api except this endpoint
// itself (a tool calling the MCP server would recurse). Query strings go in
// `query`, never in the path, so they are encoded once and correctly.
// "." and ".." segments (or their %2e spellings, which URL parsing also
// resolves) are refused: "/api/x/../mcp" would otherwise normalize into this
// endpoint and "/api/../health" out of /api. routes.ts checks the normalized
// path again before replaying, so this is the first of two locks.
const API_PATH = "^(?!.*/(?:\\.|%2[eE]){1,2}(?:/|$))/api/(?!mcp(?:/|$))[A-Za-z0-9._~%:@/-]*$";

const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const UUID = "^[0-9a-fA-F-]{36}$";

const queryParams: JsonSchema = {
  type: "object",
  description: "Query string parameters, e.g. {\"limit\": 20, \"q\": \"tokyo\"}. Values are sent as strings.",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
};

const source: JsonSchema = {
  anyOf: [
    { type: "string", minLength: 1, maxLength: 100, description: "Short app name, e.g. \"Claude\"." },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        app: { type: "string", maxLength: 100 },
        book: { type: "string", maxLength: 255 },
        author: { type: "string", maxLength: 255 },
        location: { type: "string", maxLength: 255 },
        rawContext: { type: "string", maxLength: 5000 },
      },
    },
  ],
  description: "Where the note came from: an app name, or {app, book, author, location, rawContext}.",
};

const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const num = (o: Record<string, unknown>, k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);

export const TOOLS: Tool[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "The signed-in user this connection acts as (from the token). Call it first if you are unsure whose data you are touching.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, ctx) => apiResult(await ctx.call({ method: "GET", path: "/api/auth/me" })),
  },
  {
    name: "read_docs",
    title: "Read the API docs",
    description:
      "The site's developer docs as markdown. With no page: the index of every page. With a page slug (e.g. \"journal-api\", \"knowledge-api\", \"auth\", \"conventions\", \"elements-directory\"): that whole page. Read the relevant page before using api_get or api_write on an element you have not used yet; the docs are the contract for every path, field and error.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", pattern: "^[a-z0-9-]{1,60}$", description: "Docs page slug. Omit for the index." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const page = str(args, "page");
      const res = await ctx.docs(page);
      if (res.status === 404) return textResult(`No docs page "${page}". Call read_docs with no page for the index.`, true);
      if (res.status >= 400) return textResult(`HTTP ${res.status} fetching the docs`, true);
      return textResult(res.text);
    },
  },
  {
    name: "api_get",
    title: "API read",
    description:
      "GET any shanejli.com API path as the signed-in user, for everything the typed tools do not cover (trips, courses, scoreboard, vocabulary, practice, training plans, tea, skincare, comments, versions...). Path starts with /api/, query parameters go in `query`. Read-only. See read_docs for the paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", pattern: API_PATH, maxLength: 500, description: "e.g. /api/trips or /api/journal/entries/2026-11-17/comments" },
        query: queryParams,
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(await ctx.call({ method: "GET", path: args.path as string, query: args.query as ApiCall["query"] })),
  },
  {
    name: "api_write",
    title: "API write",
    description:
      "POST, PUT, PATCH or DELETE any shanejli.com API path as the signed-in user. This changes real data on the live site: check the docs page for the route first (read_docs), and prefer a typed tool when one fits. The token's scopes decide what is allowed; a 403 names the missing scope. For the journal revert and suggestion-approve routes pass the version number as ifMatch.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", pattern: API_PATH, maxLength: 500 },
        query: queryParams,
        body: { type: "object", description: "JSON request body. Omit for DELETE and body-less POSTs." },
        ifMatch: {
          anyOf: [{ type: "string", maxLength: 100 }, { type: "integer", minimum: 1 }],
          description: "Sent as If-Match, for the optimistic-concurrency routes.",
        },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({
          method: args.method as ApiCall["method"],
          path: args.path as string,
          query: args.query as ApiCall["query"],
          body: args.body,
          ifMatch: args.ifMatch as ApiCall["ifMatch"],
        })
      ),
  },

  // ----- Knowledge -----
  {
    name: "knowledge_add_note",
    title: "Add a knowledge note",
    description:
      "File something learned into Knowledge as a card. Free text in, and the server's classifier picks the word or concept, language, category, definition and labels. Use for \"remember that...\", \"TIL...\", a term with its meaning. Needs scope knowledge:write. Returns the created card(s). Knowledge cards are public on shanejli.com/knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 5000, description: "The note, in plain words." },
        source,
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({
          method: "POST",
          path: "/api/knowledge/notes",
          body: args.source === undefined ? { text: args.text } : { text: args.text, source: args.source },
        })
      ),
  },
  {
    name: "knowledge_search",
    title: "Search knowledge cards",
    description:
      "List knowledge cards, newest first, optionally filtered. `search` is a case-insensitive substring match. Returns {entries, total, limit, offset}; page with offset.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", maxLength: 255 },
        category: { type: "string", maxLength: 100, description: "e.g. coding, english, general" },
        label: { type: "string", maxLength: 100 },
        language: { type: "string", maxLength: 100 },
        location: { type: "string", maxLength: 120, description: "Only cards memorized at this place." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({
          method: "GET",
          path: "/api/knowledge/entries",
          query: {
            search: str(args, "search"),
            category: str(args, "category"),
            label: str(args, "label"),
            language: str(args, "language"),
            location: str(args, "location"),
            limit: num(args, "limit") ?? 20,
            offset: num(args, "offset"),
          },
        })
      ),
  },
  {
    name: "knowledge_get",
    title: "Get a knowledge card",
    description: "One knowledge card by id, with its connections.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: UUID } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(await ctx.call({ method: "GET", path: `/api/knowledge/entries/${args.id}` })),
  },

  // ----- Journal (invite-only: every call needs journal membership) -----
  {
    name: "journal_list",
    title: "List journal entries",
    description:
      "Journal entries, newest date first. The journal is invite-only: a 403 \"Journal access required\" means this account is not a member. `q` searches bodies and appends. Returns {entries, nextCursor}; pass nextCursor back as cursor for the next page.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 100 },
        from: { type: "string", pattern: DATE, description: "YYYY-MM-DD, inclusive" },
        to: { type: "string", pattern: DATE, description: "YYYY-MM-DD, inclusive" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", pattern: DATE },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({
          method: "GET",
          path: "/api/journal/entries",
          query: {
            q: str(args, "q"),
            from: str(args, "from"),
            to: str(args, "to"),
            limit: num(args, "limit") ?? 20,
            cursor: str(args, "cursor"),
          },
        })
      ),
  },
  {
    name: "journal_get",
    title: "Read a journal entry",
    description:
      "The journal entry for one date: author, current body, version number and every append. Invite-only, like the rest of the journal.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", pattern: DATE, description: "YYYY-MM-DD" } },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => apiResult(await ctx.call({ method: "GET", path: `/api/journal/entries/${args.date}` })),
  },
  {
    name: "journal_create",
    title: "Write a journal entry",
    description:
      "Create the journal entry for a date, in GitHub-flavored markdown. There is one entry per date site-wide and the first poster becomes its permanent author; bodies cannot be edited afterwards, only appended to, so get it right. 409 when the date already has an entry (use journal_append if it is yours). Needs scope entries:write and journal membership.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", pattern: DATE, description: "YYYY-MM-DD" },
        content: { type: "string", minLength: 1, maxLength: 100_000, description: "Markdown body." },
      },
      required: ["date", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({ method: "POST", path: "/api/journal/entries", body: { date: args.date, content: args.content } })
      ),
  },
  {
    name: "journal_append",
    title: "Append to a journal entry",
    description:
      "Add a section to the end of a journal entry you author (markdown). Only the entry's author can append; anyone else gets 403 and should suggest instead (api_write POST /api/journal/entries/:date/suggestions). Needs scope entries:write.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", pattern: DATE },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
      },
      required: ["date", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({ method: "POST", path: `/api/journal/entries/${args.date}/appends`, body: { content: args.content } })
      ),
  },

  // ----- Blog (public reads) -----
  {
    name: "blog_list",
    title: "List blog posts",
    description: "Published blog posts, newest first, with excerpts. Returns {posts, nextCursor}; pass nextCursor back verbatim as cursor.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 100 },
        tag: { type: "string", maxLength: 40 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", maxLength: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) =>
      apiResult(
        await ctx.call({
          method: "GET",
          path: "/api/blog/posts",
          query: { q: str(args, "q"), tag: str(args, "tag"), limit: num(args, "limit") ?? 20, cursor: str(args, "cursor") },
        })
      ),
  },
  {
    name: "blog_get",
    title: "Read a blog post",
    description: "One blog post by slug, with its full markdown body.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", pattern: "^[a-z0-9-]{1,200}$" } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => apiResult(await ctx.call({ method: "GET", path: `/api/blog/posts/${args.slug}` })),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
