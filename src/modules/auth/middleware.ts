import type { Context, Next } from "hono";
import { jwtVerify } from "jose";
import { JWT_SECRET } from "./config";

/**
 * Auth middleware that extracts userId from JWT and sets it on the context.
 * Returns 401 if no valid token is provided.
 */
export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const { payload } = await jwtVerify(authHeader.slice(7), JWT_SECRET);
    c.set("userId", payload.userId as string);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

/**
 * Optional auth middleware — extracts userId if present, but doesn't require it.
 * Sets userId to null if no valid token.
 */
export async function optionalAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const { payload } = await jwtVerify(authHeader.slice(7), JWT_SECRET);
      c.set("userId", payload.userId as string);
    } catch {
      c.set("userId", null);
    }
  } else {
    c.set("userId", null);
  }
  await next();
}
