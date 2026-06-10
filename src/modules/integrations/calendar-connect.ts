/**
 * Per-user Google Calendar connection (SHAN-278).
 *
 * The frontend runs the GIS auth-code popup (@react-oauth/google
 * useGoogleLogin, flow "auth-code") against the WordByWord OAuth client
 * with the calendar.events scope. Popup-mode codes are exchanged with
 * redirect_uri=postmessage — no registered redirect URI involved. We
 * keep only the refresh token; access tokens are minted per request.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { userCalendarConnections } from "@/db/schema";
import { requireAuth } from "@/modules/auth/middleware";

const clientId = () => process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "";
const clientSecret = () => process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "";

export async function getConnection(userId: string): Promise<{ refreshToken: string } | null> {
  const [row] = await db
    .select({ refreshToken: userCalendarConnections.refreshToken })
    .from(userCalendarConnections)
    .where(eq(userCalendarConnections.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getAccessTokenForUser(userId: string): Promise<string | null> {
  const conn = await getConnection(userId);
  if (!conn) return null;
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: conn.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // invalid_grant = user revoked access; drop the dead connection so the
    // frontend falls back to "connect first".
    const text = await res.text();
    if (text.includes("invalid_grant")) {
      await db.delete(userCalendarConnections).where(eq(userCalendarConnections.userId, userId));
      return null;
    }
    throw new Error(`Google token refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

type CalEnv = { Variables: { userId: string } };

export const calendarConnectRoutes = new Hono<CalEnv>();
calendarConnectRoutes.use("*", requireAuth);

/** Connection state + the client id the frontend popup must use. */
calendarConnectRoutes.get("/status", async (c) => {
  const userId = c.get("userId");
  const conn = await getConnection(userId);
  return c.json({ connected: !!conn, clientId: clientId() });
});

const connectBody = z.object({ code: z.string().min(1) });

calendarConnectRoutes.post("/connect", zValidator("json", connectBody), async (c) => {
  const userId = c.get("userId");
  const { code } = c.req.valid("json");
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    // GIS popup-mode auth codes exchange against the literal string
    // "postmessage" instead of a registered redirect URI.
    redirect_uri: "postmessage",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: `Google code exchange failed: ${text.slice(0, 200)}` }, 502);
  }
  const data = (await res.json()) as { refresh_token?: string };
  if (!data.refresh_token) {
    // Happens when consent was previously granted without offline access.
    // The frontend popup always asks with prompt=consent, so this is rare.
    return c.json(
      { error: "Google did not return a refresh token — revoke access at myaccount.google.com/permissions and reconnect" },
      502,
    );
  }
  await db
    .insert(userCalendarConnections)
    .values({ userId, refreshToken: data.refresh_token })
    .onConflictDoUpdate({
      target: userCalendarConnections.userId,
      set: { refreshToken: data.refresh_token, createdAt: new Date() },
    });
  return c.json({ connected: true });
});

calendarConnectRoutes.delete("/connect", async (c) => {
  const userId = c.get("userId");
  await db.delete(userCalendarConnections).where(eq(userCalendarConnections.userId, userId));
  return c.json({ connected: false });
});
