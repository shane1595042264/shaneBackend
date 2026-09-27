import { Hono } from "hono";
import { zValidator } from "@/modules/shared/zod-validator";
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

/**
 * jose error codes that mean "this credential is bad" — the caller's fault, and
 * final. Everything else out of `jwtVerify` is treated as a failure to reach or
 * read Google's key set (see the catch in `POST /google` below).
 *
 * SHAN-537: allowlisting the credential-side causes rather than the transport
 * ones is deliberate and is the whole point of the fix. The credential-side
 * failures of `jwtVerify` are a closed set (jose exports exactly these error
 * classes); the transport failures are open-ended — any fetch/DNS/TLS error, a
 * non-200 from googleapis.com, a future jose error code. Defaulting an
 * unrecognized failure to "retry, and log it" can only ever cost a log line,
 * whereas defaulting it to 401 tells a user that a credential Google minted a
 * second ago is invalid, which is both wrong and unactionable.
 */
const INVALID_CREDENTIAL_CODES = new Set([
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED", // wrong audience / issuer
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY", // the token's kid is not in Google's live key set
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWK_INVALID",
]);

const googleAuthSchema = z.object({
  // Real Google ID tokens (JWTs) are ~1-2KB; 8KB is a generous cap that still
  // rejects multi-MB payloads before they reach zod + jwtVerify on this public,
  // unauthenticated endpoint (memory-pressure/DoS guard).
  credential: z.string().max(8192),
});

type AuthEnv = { Variables: { userId: string | null; tokenScopes: string[] | null } };
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

    // Verify Google ID token.
    //
    // SHAN-537: this catch used to return 401 "Invalid Google token" for every
    // failure. `GOOGLE_JWKS` is a remote key set, so `jwtVerify` makes a live
    // request to googleapis.com, and jose signals a failure to reach or read it
    // three ways: JWKSTimeout, a bare JOSEError (non-200 response, or a body
    // that will not parse as JSON), and a re-thrown raw fetch error for DNS,
    // connection-refused and TLS failures. All three used to be reported to the
    // user as a bad credential. That made a Google certs outage into a total
    // login outage that read as user error, told every visitor their valid
    // token was invalid, and produced no log lines at all, because `err` was
    // never read and the handler returned instead of rethrowing. 401 also reads
    // as final, so it stops the retry that would have succeeded.
    let payload: Record<string, unknown>;
    try {
      const { payload: p } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = p as Record<string, unknown>;
    } catch (err: any) {
      if (INVALID_CREDENTIAL_CODES.has(err?.code)) {
        return c.json({ error: "Invalid Google token" }, 401);
      }
      // Could not reach or read Google's key set. Log the real cause (this is
      // the only record a certs outage leaves) and tell the client it is worth
      // retrying. Never return err.message — it can carry request internals.
      console.error(
        `[auth] POST /api/auth/google: could not verify against Google's key set (code=${err?.code ?? "none"}):`,
        err
      );
      return c.json(
        {
          error: "Could not reach Google to verify your sign-in. Please try again.",
          code: "google_keys_unavailable",
        },
        503
      );
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
        timezone: user.timezone,
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
      timezone: user.timezone,
    },
  });
});

// IANA timezone names: at least one slash, alphanumeric + a few separators.
// We validate against the runtime's known zones below before persisting.
const timezoneSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/),
});

authRoutes.patch(
  "/me/timezone",
  requireAuth,
  zValidator("json", timezoneSchema),
  async (c) => {
    if (c.get("tokenScopes") !== null) {
      return c.json({ error: "Profile updates require a browser session, not a PAT" }, 403);
    }
    const userId = c.get("userId") as string;
    const { timezone } = c.req.valid("json");

    // Reject anything Intl doesn't recognize — protects DB from typos and
    // also guards downstream Intl.DateTimeFormat calls from RangeError.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return c.json({ error: "Unknown timezone" }, 400);
    }

    const [updated] = await db
      .update(users)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ timezone: users.timezone });

    if (!updated) return c.json({ error: "User not found" }, 404);
    return c.json({ timezone: updated.timezone });
  },
);

const ALLOWED_SCOPES = [
  "entries:write",
  "suggestions:write",
  "comments:write",
  "reactions:write",
  "knowledge:write",
  "trips:write",
  "practice:write",
] as const;

const mintTokenSchema = z.object({
  name: z.string().min(1).max(80),
  // Only a handful of valid scopes exist; cap array length so a huge array
  // can't spike memory during validation (parity with name's .max(80)).
  scopes: z.array(z.enum(ALLOWED_SCOPES)).max(20).default([]),
});

authRoutes.post("/tokens", requireAuth, zValidator("json", mintTokenSchema), async (c) => {
  if (c.get("tokenScopes") !== null) {
    return c.json({ error: "Token creation requires a browser session, not a PAT" }, 403);
  }
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

// Reject malformed :id before it reaches the uuid column — a bad id would
// otherwise throw "invalid input syntax for type uuid" in Postgres and surface
// as a misleading 500 instead of a 400. Mirrors the SHAN-362 journal guard.
const uuidParamSchema = z.object({ id: z.string().uuid() });

authRoutes.delete(
  "/tokens/:id",
  requireAuth,
  zValidator("param", uuidParamSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id: tokenId } = c.req.valid("param");
    const ok = await revokeToken(userId, tokenId);
    return ok ? c.body(null, 204) : c.json({ error: "Token not found" }, 404);
  },
);
