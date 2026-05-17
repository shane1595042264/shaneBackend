// src/modules/auth/middleware.ts
import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { JWT_SECRET } from "./config";
import { lookupActiveToken, TOKEN_PREFIX } from "./tokens";
import { db } from "@/db/client";
import { users } from "@/db/schema";

export type AuthVars = {
  userId: string | null;
  tokenScopes: string[] | null;
  tokenId: string | null;
};

type ResolvedAuth = {
  userId: string | null;
  tokenScopes: string[] | null;
  tokenId: string | null;
};

async function resolveAuth(authHeader: string | undefined): Promise<ResolvedAuth> {
  if (!authHeader?.startsWith("Bearer ")) return { userId: null, tokenScopes: null, tokenId: null };
  const value = authHeader.slice("Bearer ".length).trim();
  if (value.startsWith(TOKEN_PREFIX)) {
    const result = await lookupActiveToken(value);
    if (!result) return { userId: null, tokenScopes: null, tokenId: null };
    return { userId: result.userId, tokenScopes: result.scopes, tokenId: result.tokenId };
  }
  try {
    const { payload } = await jwtVerify(value, JWT_SECRET);
    return { userId: (payload.userId as string) ?? null, tokenScopes: null, tokenId: null };
  } catch {
    return { userId: null, tokenScopes: null, tokenId: null };
  }
}

export const optionalAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const { userId, tokenScopes, tokenId } = await resolveAuth(c.req.header("Authorization"));
  c.set("userId", userId);
  c.set("tokenScopes", tokenScopes);
  c.set("tokenId", tokenId);
  await next();
});

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const { userId, tokenScopes, tokenId } = await resolveAuth(c.req.header("Authorization"));
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  c.set("userId", userId);
  c.set("tokenScopes", tokenScopes);
  c.set("tokenId", tokenId);
  await next();
});

export function requireScope(scope: string) {
  return createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
    const scopes = c.get("tokenScopes");
    // PATs require explicit scope; JWTs (scopes === null) bypass
    if (scopes !== null && !scopes.includes(scope)) {
      return c.json({ error: `Token missing required scope: ${scope}` }, 403);
    }
    await next();
  });
}

/**
 * Gate a route to admin-whitelisted users only (e.g. periodic-table element
 * writes, future moderation actions).
 *
 * Rules:
 *  - JWT required. PATs are NEVER admin — admin actions go through the browser.
 *  - The user's email is looked up from the users table and compared against
 *    the comma-separated ADMIN_EMAILS env var (lowercased, trimmed).
 *  - If ADMIN_EMAILS is empty/unset, every request 403s. Safe default.
 *
 * Returns: middleware factory (call as `requireAdmin()` per route).
 */
export function requireAdmin() {
  return createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Authentication required" }, 401);

    if (c.get("tokenScopes") !== null) {
      return c.json({ error: "Admin actions require a browser session, not a PAT" }, 403);
    }

    const adminEmails = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (adminEmails.length === 0) {
      return c.json({ error: "Admin access is not configured on this server" }, 403);
    }

    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));

    if (!row || !adminEmails.includes(row.email.toLowerCase())) {
      return c.json({ error: "Admin access required" }, 403);
    }

    await next();
  });
}
