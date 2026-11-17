import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// requireAuth: "Bearer good" is a signed-in caller, anything else is 401.
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    if (c.req.header("Authorization") !== "Bearer good") return c.json({ error: "Authentication required" }, 401);
    c.set("userId", "u1");
    c.set("tokenScopes", ["knowledge:write"]);
    await next();
  },
}));

import { buildUrl, createMcpRoutes } from "@/modules/mcp/routes";
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from "@/modules/mcp/protocol";
import { TOOLS } from "@/modules/mcp/tools";
import { validate } from "@/modules/mcp/schema";

// The fake app the tools are replayed against: records every request it gets
// and answers from `reply`.
const seen: { method: string; url: string; auth: string | null; ifMatch: string | null; body: unknown }[] = [];
let reply: (req: Request) => Response = () => Response.json({ ok: true });

const dispatch = async (req: Request) => {
  const text = await req.text();
  seen.push({
    method: req.method,
    url: new URL(req.url).pathname + new URL(req.url).search,
    auth: req.headers.get("Authorization"),
    ifMatch: req.headers.get("If-Match"),
    body: text ? JSON.parse(text) : undefined,
  });
  return reply(req);
};

const app = new Hono().route("/api/mcp", createMcpRoutes(dispatch));

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const call = async (name: string, args?: unknown) => {
  const res = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  return (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number } };
};

beforeEach(() => {
  seen.length = 0;
  reply = () => Response.json({ ok: true });
});

describe("transport", () => {
  it("401s without a valid token and says it is a bearer server", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("refuses a cross-site browser Origin and allows none or the site's own", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://shanejli.com" })).status).toBe(200);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("is POST-only", async () => {
    const res = await app.request("/api/mcp", { headers: { Authorization: "Bearer good" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("answers a parse error with JSON-RPC -32700", async () => {
    const res = await rpc("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers a batch, skipping notifications", async () => {
    const res = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "nope" },
    ]);
    const body = (await res.json()) as { id: number }[];
    expect(body.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("protocol", () => {
  it("initializes, echoing a supported version and falling back to the latest", async () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } });
      expect(((await res.json()) as any).result.protocolVersion).toBe(v);
    }
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    const body = (await res.json()) as any;
    expect(body.result).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "shanejli" },
    });
    expect(body.result.instructions).toContain("read_docs");
  });

  it("lists every tool with its schema and hints", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = ((await res.json()) as any).result;
    expect(tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
  });

  it("method not found and unknown tool are JSON-RPC errors", async () => {
    expect(await (await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })).json()).toMatchObject({
      error: { code: -32601 },
    });
    expect(await call("drop_tables")).toMatchObject({ error: { code: -32602 } });
  });

  it("bad arguments come back as a tool error the model can read, and nothing is called", async () => {
    const r = await call("journal_get", { date: "yesterday", extra: 1 });
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content[0].text).toContain("arguments.date");
    expect(r.result?.content[0].text).toContain("arguments.extra: unknown field");
    expect(seen).toHaveLength(0);
  });
});

describe("tools", () => {
  it("replays the request in-process with the caller's own token", async () => {
    reply = () => Response.json({ entries: [{ id: "e1" }] }, { status: 201 });
    const r = await call("knowledge_add_note", { text: "gracias means thank you", source: "Claude" });
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/api/knowledge/notes",
        auth: "Bearer good",
        ifMatch: null,
        body: { text: "gracias means thank you", source: "Claude" },
      },
    ]);
    expect(JSON.parse(r.result!.content[0].text)).toEqual({ entries: [{ id: "e1" }] });
    expect(r.result?.isError).toBeUndefined();
  });

  it("encodes query parameters and drops empty ones", async () => {
    await call("knowledge_search", { search: "ring buffer & co", limit: 5 });
    expect(seen[0].url).toBe("/api/knowledge/entries?search=ring+buffer+%26+co&limit=5");
    await call("journal_list", {});
    expect(seen[1].url).toBe("/api/journal/entries?limit=20");
  });

  it("surfaces an API error with its status, as a tool error", async () => {
    reply = () => Response.json({ error: "Journal access required" }, { status: 403 });
    const r = await call("journal_get", { date: "2026-11-17" });
    expect(seen[0].url).toBe("/api/journal/entries/2026-11-17");
    expect(r.result?.isError).toBe(true);
    expect(r.result?.content[0].text).toMatch(/^HTTP 403\n/);
  });

  it("api_write sends method, body and If-Match", async () => {
    reply = () => new Response(null, { status: 204 });
    const r = await call("api_write", {
      method: "POST",
      path: "/api/journal/entries/2026-11-01/revert",
      body: { target_version_num: 2 },
      ifMatch: 3,
    });
    expect(seen[0]).toMatchObject({ method: "POST", ifMatch: "3", body: { target_version_num: 2 } });
    expect(r.result?.content[0].text).toContain("204");
  });

  it("the generic tools cannot leave /api or call the MCP endpoint itself", async () => {
    for (const path of [
      "/health",
      "/api/mcp",
      "/api/mcp/x",
      "/api/../health",
      "/api/x/../mcp",
      "/api/%2e%2e/health",
      "/api/x/%2E%2E/mcp",
      "/api/./trips",
      "/api/x?y=1",
      "api/trips",
    ]) {
      const r = await call("api_get", { path });
      expect(r.result?.isError, path).toBe(true);
    }
    expect(seen).toHaveLength(0);
    await call("api_get", { path: "/api/mcpx" }); // a sibling path is fine
    expect(seen).toHaveLength(1);
  });

  it("re-checks the normalized path before dispatching", () => {
    expect(() => buildUrl({ method: "GET", path: "/api/x/../mcp" })).toThrow(/not allowed/);
    expect(() => buildUrl({ method: "GET", path: "/api/%2e%2e/health" })).toThrow(/not allowed/);
    expect(() => buildUrl({ method: "GET", path: "/api/MCP" })).toThrow(/not allowed/);
    expect(buildUrl({ method: "GET", path: "/api/trips", query: { limit: 2, q: "" } })).toBe("/api/trips?limit=2");
  });

  it("truncates a huge response and says so", async () => {
    reply = () => Response.json({ big: "x".repeat(80_000) });
    const r = await call("api_get", { path: "/api/trips" });
    expect(r.result!.content[0].text.length).toBeLessThan(61_000);
    expect(r.result!.content[0].text).toContain("[truncated:");
  });
});

describe("read_docs", () => {
  it("fetches the index or a page, and reports an unknown page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/llms.txt")) return new Response("# index");
      if (url.endsWith("/docs/raw/knowledge-api")) return new Response("# Knowledge API");
      return new Response("nope", { status: 404 });
    });
    expect((await call("read_docs", {})).result?.content[0].text).toBe("# index");
    expect((await call("read_docs", { page: "knowledge-api" })).result?.content[0].text).toBe("# Knowledge API");
    const missing = await call("read_docs", { page: "no-such-page" });
    expect(missing.result?.isError).toBe(true);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://shanejli.com/llms.txt",
      "https://shanejli.com/docs/raw/knowledge-api",
      "https://shanejli.com/docs/raw/no-such-page",
    ]);
    fetchSpy.mockRestore();
  });
});

describe("validate", () => {
  it("handles anyOf, nested objects and additionalProperties schemas", () => {
    const schema = TOOLS.find((t) => t.name === "knowledge_add_note")!.inputSchema;
    expect(validate(schema, { text: "x", source: { book: "Dune" } })).toEqual([]);
    expect(validate(schema, { text: "x", source: { isbn: "1" } })).toHaveLength(1);
    expect(validate(schema, { text: "" })).toEqual(["arguments.text: must be at least 1 characters"]);
    const get = TOOLS.find((t) => t.name === "api_get")!.inputSchema;
    expect(validate(get, { path: "/api/trips", query: { limit: 5, q: "x", all: true } })).toEqual([]);
    expect(validate(get, { path: "/api/trips", query: { nested: { a: 1 } } })).toHaveLength(1);
  });
});
