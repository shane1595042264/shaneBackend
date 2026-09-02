import { Hono } from "hono";
import { requireAuth, type AuthVars } from "@/modules/auth/middleware";
import { getOrCreateSyncAccount } from "./accounts-repo";
import { ensureSupersyncUser } from "./supersync-db";
import { signSupersyncToken } from "./token";

export const blitzRoutes = new Hono<{ Variables: AuthVars }>();

function syncBaseUrl(): string {
  return process.env.SUPERSYNC_PUBLIC_URL || "https://sync.shanejli.com";
}

/**
 * POST /api/blitz/sync-session
 * Browser-session only (PATs are refused, same rule as PAT minting): hands the
 * signed-in Google user everything a Blitz client needs to sync, and creates
 * their SuperSync account on first call. The encryption key is the same for
 * every device of the same user, so this is "sign in and you're synced".
 */
blitzRoutes.post("/sync-session", requireAuth, async (c) => {
  if (c.get("tokenScopes") !== null) {
    return c.json({ error: "Blitz sync sessions require a browser session, not a PAT" }, 403);
  }
  const userId = c.get("userId") as string;
  const account = await getOrCreateSyncAccount(userId);
  // token_version lives on the SuperSync side and changes when the user hits
  // "Revoke & Replace token" in the app; re-read it so a fresh token always
  // matches, instead of caching a stale version here.
  const remote = await ensureSupersyncUser(account.email);
  const { token, expiresAt } = await signSupersyncToken({
    userId: remote.id,
    email: account.email,
    tokenVersion: remote.tokenVersion,
  });
  return c.json({
    baseUrl: syncBaseUrl(),
    accessToken: token,
    encryptKey: account.encryptKey,
    email: account.email,
    expiresAt,
  });
});
