import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { slotAssignments } from "@/db/schema";
import { requireAuth } from "@/modules/auth/middleware";

type AuthEnv = { Variables: { userId: string } };
const slotRoutes = new Hono<AuthEnv>();

slotRoutes.use("*", requireAuth);

// GET / — get the user's slot assignments
slotRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  const rows = await db
    .select()
    .from(slotAssignments)
    .where(eq(slotAssignments.userId, userId))
    .limit(1);

  const assignments =
    rows.length > 0
      ? (rows[0].assignments as Record<string, string>)
      : {};
  return c.json({ assignments });
});

const putSchema = z.object({
  assignments: z.record(
    z.string().regex(/^\d+$/, "Keys must be atomic numbers"),
    z.string().min(1, "App ID required")
  ),
});

// PUT / — save the user's slot assignments
slotRoutes.put("/", zValidator("json", putSchema), async (c) => {
  const userId = c.get("userId");
  const { assignments } = c.req.valid("json");

  // Validate atomic numbers are 1-118
  for (const key of Object.keys(assignments)) {
    const num = parseInt(key, 10);
    if (num < 1 || num > 118) {
      return c.json({ error: `Invalid atomic number: ${key}` }, 400);
    }
  }

  // Validate no duplicate app IDs
  const appIds = Object.values(assignments);
  if (new Set(appIds).size !== appIds.length) {
    return c.json({ error: "Duplicate app IDs not allowed" }, 400);
  }

  // Upsert
  await db
    .insert(slotAssignments)
    .values({ userId, assignments, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: slotAssignments.userId,
      set: { assignments, updatedAt: new Date() },
    });

  return c.json({ assignments });
});

export { slotRoutes };
