import { Hono } from "hono";
import { processLocationPing, processTransition } from "@/modules/integrations/owntracks";

export const locationRoutes = new Hono();

/**
 * POST /
 * OwnTracks HTTP webhook endpoint.
 * Configure OwnTracks app to POST to: https://shanebackend-production.up.railway.app/api/location
 *
 * OwnTracks sends JSON with _type: "location", "transition", "waypoint", etc.
 * We process location pings and waypoint transitions.
 *
 * Auth: Bearer token via OWNTRACKS_TOKEN env var (optional but recommended).
 */
locationRoutes.post("/", async (c) => {
  // Simple bearer token auth (optional)
  const expectedToken = process.env.OWNTRACKS_TOKEN;
  if (expectedToken) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const payload = await c.req.json();

  if (payload._type === "location") {
    const result = await processLocationPing(payload);
    // OwnTracks expects an empty JSON array response
    return c.json([]);
  }

  if (payload._type === "transition") {
    const result = await processTransition(payload);
    return c.json([]);
  }

  // OwnTracks sends other types (lwt, waypoint) — acknowledge them
  return c.json([]);
});

/**
 * GET /today
 * Get all location pings for today (for debugging).
 */
locationRoutes.get("/today", async (c) => {
  const { db } = await import("@/db/client");
  const { activities } = await import("@/db/schema");
  const { eq, and } = await import("drizzle-orm");

  const today = new Date().toISOString().split("T")[0];

  const pings = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.date, today),
        eq(activities.source, "google_maps")
      )
    );

  return c.json({ date: today, count: pings.length, pings });
});
