// SHAN-704: the Model Context Protocol, the part this server needs.
//
// A stateless tools-only server over Streamable HTTP: every client message is
// a JSON-RPC 2.0 POST, every answer is a plain application/json response (the
// transport allows that instead of an SSE stream), and there is no session to
// keep, so any Railway instance can answer any request. Without resources,
// prompts, sampling or server-initiated messages the protocol is small enough
// to implement directly rather than pull in the SDK and its transport
// plumbing: initialize, ping, tools/list, tools/call, and notifications
// acknowledged with no response.

import { validate } from "./schema";
import { TOOLS, TOOLS_BY_NAME, textResult, type ToolContext } from "./tools";

/** Newest first. A client asking for one of these gets it echoed back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

export const SERVER_INFO = {
  name: "shanejli",
  title: "Shane's Periodic Table of Life",
  version: "1.0.0",
};

export const INSTRUCTIONS = `Tools for shanejli.com, acting as the user who owns the token this connection was set up with.

- Every tool replays a normal API request with that token, so its scopes decide what a write may do (a 403 names the missing scope) and per-token rate limits apply (429 means wait for Retry-After).
- Writes change the live site. The journal is invite-only and append-only: an entry's body cannot be edited after it is created, only appended to. Knowledge cards and blog posts are public.
- Typed tools cover the common jobs (knowledge notes and search, journal, blog). For anything else, read the element's docs page with read_docs, then use api_get or api_write.`;

export const JSONRPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type Id = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: Id, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * One JSON-RPC message in, its response out, or null for a notification
 * (which never gets one).
 */
export async function handleMessage(msg: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id = isObject(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    return rpcError(id, JSONRPC_ERRORS.invalidRequest, "Invalid JSON-RPC 2.0 message");
  }
  // No id: a notification (notifications/initialized, notifications/cancelled...).
  // Nothing to answer, and nothing here needs to act on one.
  if (!("id" in msg)) return null;
  const id = msg.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, JSONRPC_ERRORS.invalidRequest, "id must be a string or number");
  }
  const params = isObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : LATEST_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { title, ...annotations },
        })),
      });
    case "tools/call": {
      const name = params.name;
      const tool = typeof name === "string" ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, JSONRPC_ERRORS.invalidParams, `Unknown tool: ${String(name)}`);
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isObject(args)) return rpcError(id, JSONRPC_ERRORS.invalidParams, "arguments must be an object");
      // Bad arguments are a tool error, not a protocol error, so the model
      // sees what was wrong and can correct the call.
      const problems = validate(tool.inputSchema, args);
      if (problems.length) return ok(id, textResult(`Invalid arguments:\n${problems.join("\n")}`, true));
      try {
        return ok(id, await tool.run(args, ctx));
      } catch (err) {
        console.error(`[mcp] tool ${tool.name} failed:`, (err as Error).message);
        return ok(id, textResult(`The ${tool.name} tool failed: ${(err as Error).message}`, true));
      }
    }
    default:
      return rpcError(id, JSONRPC_ERRORS.methodNotFound, `Method not found: ${msg.method}`);
  }
}
