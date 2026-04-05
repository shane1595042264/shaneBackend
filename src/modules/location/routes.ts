import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { processLocationPing, processTransition } from "@/modules/integrations/owntracks";

export const locationRoutes = new Hono();

const owntracksPayloadSchema = z.object({
  _type: z.enum(["location", "transition", "waypoint", "lwt"]),
  lat: z.number(),
  lon: z.number(),
  tst: z.number(),
  acc: z.number().optional(),
  alt: z.number().optional(),
  vel: z.number().optional(),
  batt: z.number().optional(),
  tid: z.string().optional(),
  conn: z.string().optional(),
  SSID: z.string().optional(),
  desc: z.string().optional(),
  event: z.string().optional(),
}).passthrough();

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
locationRoutes.post("/", zValidator("json", owntracksPayloadSchema), async (c) => {
  // Simple bearer token auth (optional)
  const expectedToken = process.env.OWNTRACKS_TOKEN;
  if (expectedToken) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const payload = c.req.valid("json");

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
