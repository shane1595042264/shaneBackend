// src/modules/auth/middleware.ts
import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import { JWT_SECRET } from "./config";
import { lookupActiveToken, TOKEN_PREFIX } from "./tokens";

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
