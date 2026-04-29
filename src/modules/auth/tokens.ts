// src/modules/auth/tokens.ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { apiTokens } from "@/db/schema";

export const TOKEN_PREFIX = "pat_";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function mintToken(
  userId: string,
  name: string,
  scopes: string[]
): Promise<{ raw: string; id: string }> {
  const raw = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, name, tokenHash, scopes })
    .returning({ id: apiTokens.id });
  return { raw, id: row.id };
}

export async function listTokens(userId: string) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId));
}

export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id });
  return result.length > 0;
}

export async function lookupActiveToken(raw: string) {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(raw);
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
  if (!row) return null;
  // Fire-and-forget last_used_at update
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id));
  return { userId: row.userId, scopes: row.scopes };
}
