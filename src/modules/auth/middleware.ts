// src/modules/auth/middleware.ts
import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import { JWT_SECRET } from "./config";
import { lookupActiveToken, TOKEN_PREFIX } from "./tokens";

type AuthVars = {
  userId: string | null;
  tokenScopes: string[] | null;
};

async function resolveAuth(authHeader: string | undefined): Promise<{ userId: string | null; tokenScopes: string[] | null }> {
  if (!authHeader?.startsWith("Bearer ")) return { userId: null, tokenScopes: null };
  const value = authHeader.slice("Bearer ".length).trim();
  if (value.startsWith(TOKEN_PREFIX)) {
    const result = await lookupActiveToken(value);
    if (!result) return { userId: null, tokenScopes: null };
    return { userId: result.userId, tokenScopes: result.scopes };
  }
  try {
    const { payload } = await jwtVerify(value, JWT_SECRET);
    return { userId: (payload.userId as string) ?? null, tokenScopes: null };
  } catch {
    return { userId: null, tokenScopes: null };
  }
}

export const optionalAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const { userId, tokenScopes } = await resolveAuth(c.req.header("Authorization"));
  c.set("userId", userId);
  c.set("tokenScopes", tokenScopes);
  await next();
});

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const { userId, tokenScopes } = await resolveAuth(c.req.header("Authorization"));
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  c.set("userId", userId);
  c.set("tokenScopes", tokenScopes);
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
