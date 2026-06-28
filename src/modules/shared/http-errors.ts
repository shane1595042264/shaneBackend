import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Uniform JSON 404 for any route that no handler matched.
 *
 * Without this, Hono falls through to its default plain-text "404 Not Found",
 * which is inconsistent with every real route in the app (all of which return
 * a JSON `{ error }` shape). Clients/agents can then reliably `res.json()`
 * every response instead of special-casing the plain-text body.
 */
export function notFoundHandler(c: Context) {
  return c.json({ error: "Not Found", path: c.req.path }, 404);
}

/**
 * Global error handler — replaces Hono's default plain-text 500 with a uniform
 * JSON error shape and logs the failure with method + path context.
 *
 * A thrown `HTTPException` is honored (its status + message become the JSON
 * body); anything else is treated as an unexpected 500 and the real error is
 * logged but not leaked to the client.
 */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    console.error(`[error] ${c.req.method} ${c.req.path}: ${err.status} ${err.message}`);
    return c.json({ error: err.message || "Error" }, err.status);
  }
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "Internal Server Error" }, 500);
}
