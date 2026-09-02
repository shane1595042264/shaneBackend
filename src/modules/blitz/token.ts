import { SignJWT } from "jose";

export const SUPERSYNC_TOKEN_TTL_DAYS = 365;

// Mirrors packages/super-sync-server/src/auth.ts in the fork: HS256, payload
// { userId: int, email, tokenVersion }, verified by the server against its own
// users row (isVerified + tokenVersion must match).
export async function signSupersyncToken(input: {
  userId: number;
  email: string;
  tokenVersion: number;
}): Promise<{ token: string; expiresAt: string }> {
  const secret = process.env.SUPERSYNC_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SUPERSYNC_JWT_SECRET must be set (min 32 chars)");
  }
  // Whole seconds, so the reported expiresAt is exactly the JWT's exp claim.
  const expSeconds = Math.floor(Date.now() / 1000) + SUPERSYNC_TOKEN_TTL_DAYS * 24 * 60 * 60;
  const token = await new SignJWT({
    userId: input.userId,
    email: input.email,
    tokenVersion: input.tokenVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(new TextEncoder().encode(secret));
  return { token, expiresAt: new Date(expSeconds * 1000).toISOString() };
}
