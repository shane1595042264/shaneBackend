import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { JWT_SECRET } from "./config";
import { optionalAuth, requireAuth } from "./middleware";
import { mintToken, listTokens, revokeToken } from "./tokens";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const googleAuthSchema = z.object({
  credential: z.string(),
});

type AuthEnv = { Variables: { userId: string | null } };
export const authRoutes = new Hono<AuthEnv>();

/**
 * POST /api/auth/google
 * Accepts a Google ID token (credential), verifies it, creates/finds user, returns JWT.
 */
authRoutes.post(
  "/google",
  zValidator("json", googleAuthSchema),
  async (c) => {
    const { credential } = c.req.valid("json");

    // Verify Google ID token
    let payload: Record<string, unknown>;
    try {
      const { payload: p } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = p as Record<string, unknown>;
    } catch (err: any) {
      return c.json({ error: "Invalid Google token" }, 401);
    }

    const googleId = payload.sub as string;
    const email = payload.email as string;
    const name = (payload.name as string) || null;
    const avatarUrl = (payload.picture as string) || null;

    if (!googleId || !email) {
      return c.json({ error: "Invalid token payload" }, 400);
    }

    // Upsert user
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId));

    if (!user) {
      [user] = await db
        .insert(users)
        .values({ googleId, email, name, avatarUrl })
        .returning();
    } else {
      // Update name/avatar if changed
      [user] = await db
        .update(users)
        .set({ email, name, avatarUrl, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
    }

    // Create session JWT
    const token = await new SignJWT({
      userId: user.id,
      email: user.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(JWT_SECRET);

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
    });
  }
);

/**
 * GET /api/auth/me
 * Returns current user info from JWT.
 */
authRoutes.get("/me", optionalAuth, async (c) => {
  const userId = c.get("userId") as string | null;
  if (!userId) return c.json({ user: null });

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId));

  if (!user) return c.json({ user: null });

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
  });
});

const ALLOWED_SCOPES = [
  "entries:write",
  "suggestions:write",
  "comments:write",
  "reactions:write",
] as const;

const mintTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(ALLOWED_SCOPES)).default([]),
});

authRoutes.post("/tokens", requireAuth, zValidator("json", mintTokenSchema), async (c) => {
  const userId = c.get("userId") as string;
  const { name, scopes } = c.req.valid("json");
  const { raw, id } = await mintToken(userId, name, scopes);
  return c.json({ id, token: raw }, 201);
});

authRoutes.get("/tokens", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const tokens = await listTokens(userId);
  return c.json({ tokens });
});

authRoutes.delete("/tokens/:id", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const tokenId = c.req.param("id");
  const ok = await revokeToken(userId, tokenId);
  return ok ? c.body(null, 204) : c.json({ error: "Token not found" }, 404);
});
