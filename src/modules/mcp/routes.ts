// SHAN-704: POST /api/mcp, the Streamable HTTP endpoint (see protocol.ts).
//
// Reach it as https://shanejli.com/api/mcp (the frontend's /api rewrite) or on
// the Railway origin. Authenticate with `Authorization: Bearer <PAT>`; a
// browser JWT works too but expires, so a PAT is what a client should hold.
// The tools replay requests against the app in-process via `dispatch`, with
// the same header, so this route grants nothing the token could not already
// do over plain HTTP.

import { Hono } from "hono";
import { requireAuth, type AuthVars } from "@/modules/auth/middleware";
import { handleMessage, JSONRPC_ERRORS, rpcError, type JsonRpcResponse } from "./protocol";
import type { ApiCall, ApiResult, ToolContext } from "./tools";

export type Dispatch = (req: Request) => Response | Promise<Response>;

/** Generous for a 100k-character journal entry; anything bigger is not a tool call. */
const MAX_BODY_BYTES = 1_000_000;
/** Batches were dropped from the protocol in 2025-06-18; older clients may still send small ones. */
const MAX_BATCH = 20;

export const DOCS_ORIGIN = process.env.DOCS_ORIGIN ?? "https://shanejli.com";

// A browser page on another site must not be able to drive a signed-in
// user's tools (the transport spec's DNS-rebinding rule). Claude Code and
// other native clients send no Origin at all.
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "shanejli.com" || host.endsWith(".shanejli.com") || host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

export function buildUrl(call: ApiCall): string {
  const url = new URL(call.path, "http://mcp.internal");
  // Second lock after the tool schemas' path pattern: whatever the path was
  // spelled as, what actually gets dispatched must be under /api and must not
  // be this endpoint.
  if (!url.pathname.startsWith("/api/") || /^\/api\/mcp(?:\/|$)/i.test(url.pathname)) {
    throw new Error(`Path not allowed: ${url.pathname}`);
  }
  for (const [k, v] of Object.entries(call.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const docsCache = new Map<string, { at: number; status: number; text: string }>();
const DOCS_TTL_MS = 10 * 60 * 1000;

async function fetchDocs(slug?: string): Promise<{ status: number; text: string }> {
  const key = slug ?? "";
  const hit = docsCache.get(key);
  if (hit && Date.now() - hit.at < DOCS_TTL_MS) return hit;
  const url = slug ? `${DOCS_ORIGIN}/docs/raw/${slug}` : `${DOCS_ORIGIN}/llms.txt`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const entry = { at: Date.now(), status: res.status, text: res.ok ? await res.text() : "" };
  if (res.ok) docsCache.set(key, entry);
  return entry;
}

export function createMcpRoutes(dispatch: Dispatch) {
  const r = new Hono<{ Variables: AuthVars }>();

  r.use("*", async (c, next) => {
    if (!originAllowed(c.req.header("Origin"))) return c.json({ error: "Origin not allowed" }, 403);
    await next();
    // Tells an MCP client this is a bearer-token server when the token is
    // missing or revoked, instead of a bare 401.
    if (c.res.status === 401) c.res.headers.set("WWW-Authenticate", 'Bearer realm="shanejli.com"');
  });

  const POST_ONLY = { error: "This MCP endpoint takes POST only: JSON responses, no SSE stream, no sessions." };
  r.get("/", (c) => c.json(POST_ONLY, 405, { Allow: "POST" }));
  r.delete("/", (c) => c.json(POST_ONLY, 405, { Allow: "POST" }));

  r.post("/", requireAuth, async (c) => {
    const length = Number(c.req.header("Content-Length") ?? 0);
    if (length > MAX_BODY_BYTES) return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Request too large"), 413);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, JSONRPC_ERRORS.parse, "Parse error: body is not JSON"), 400);
    }

    const authorization = c.req.header("Authorization")!;
    const ctx: ToolContext = {
      async call(call): Promise<ApiResult> {
        const headers: Record<string, string> = { Authorization: authorization };
        if (call.body !== undefined) headers["Content-Type"] = "application/json";
        if (call.ifMatch !== undefined) headers["If-Match"] = String(call.ifMatch);
        const res = await dispatch(
          new Request(`http://mcp.internal${buildUrl(call)}`, {
            method: call.method,
            headers,
            body: call.body === undefined ? undefined : JSON.stringify(call.body),
          })
        );
        return { status: res.status, body: await readBody(res) };
      },
      docs: fetchDocs,
    };

    if (Array.isArray(payload)) {
      if (payload.length === 0 || payload.length > MAX_BATCH) {
        return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, `A batch takes 1 to ${MAX_BATCH} messages`), 400);
      }
      const out: JsonRpcResponse[] = [];
      for (const m of payload) {
        const res = await handleMessage(m, ctx);
        if (res) out.push(res);
      }
      return out.length ? c.json(out) : c.body(null, 202);
    }

    const res = await handleMessage(payload, ctx);
    return res ? c.json(res) : c.body(null, 202);
  });

  return r;
}
