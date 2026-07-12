import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireScope, requireAdmin } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { getPrescription, upsertPrescription, deletePrescription } from "./prescription-repo";
import { listLocations, upsertLocation, deleteLocation } from "./locations-repo";
import {
  createSession,
  getSessionById,
  listSessions,
  markSessionCompleted,
  deleteSession,
} from "./sessions-repo";
import { listItemsForSession, syncSessionItem } from "./session-items-repo";
import { generateSessionItems } from "./generator";
import { listPracticeableItems, getItemProgressDetail } from "./items-repo";
import { getSettings, updateSettings } from "./settings-repo";

// Per-PAT rolling-60s rate limits on the practice write surface. JWTs bypass
// (tokenId is null for browser sessions). Sync runs at runner-tick speed —
// state changes + pagehide beacon — so its bucket is much larger than the
// config-write buckets.
const prescriptionsWriteLimit = createPATRateLimit({
  bucket: "practice-prescriptions-write",
  limitPerMinute: 30,
});
const locationsWriteLimit = createPATRateLimit({
  bucket: "practice-locations-write",
  limitPerMinute: 30,
});
const sessionsWriteLimit = createPATRateLimit({
  bucket: "practice-sessions-write",
  limitPerMinute: 30,
});
const sessionItemsSyncLimit = createPATRateLimit({
  bucket: "practice-session-items-sync",
  limitPerMinute: 120,
});

export const practiceRoutes = new Hono();

// ----- Settings -----

practiceRoutes.get("/settings", async (c) => {
  const settings = await getSettings();
  return c.json({ settings });
});

const settingsPatchSchema = z
  .object({
    setsPerStrike: z.number().int().min(1).max(50).optional(),
    strikesPerLoadedLocation: z.number().int().min(1).max(50).optional(),
    locationsToSolidify: z.number().int().min(1).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

practiceRoutes.patch(
  "/settings",
  requireAuth,
  requireAdmin(),
  zValidator("json", settingsPatchSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const patch = c.req.valid("json");
    const updated = await updateSettings(userId, patch);
    return c.json({ settings: updated });
  },
);

// ----- Prescriptions -----

const itemIdParam = z.object({ itemId: z.string().uuid() });
const prescriptionBody = z.object({
  setMode: z.enum(["time", "reps"]),
  setSize: z.number().int().min(1).max(3600),
  restSeconds: z.number().int().min(0).max(3600),
});

practiceRoutes.get("/prescriptions/:itemId", zValidator("param", itemIdParam), async (c) => {
  const p = await getPrescription(c.req.valid("param").itemId);
  if (!p) return c.json({ error: "Not configured" }, 404);
  return c.json({ prescription: p });
});

practiceRoutes.put(
  "/prescriptions/:itemId",
  requireAuth,
  requireScope("practice:write"),
  prescriptionsWriteLimit,
  zValidator("param", itemIdParam),
  zValidator("json", prescriptionBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { itemId } = c.req.valid("param");
    const body = c.req.valid("json");
    const p = await upsertPrescription(itemId, userId, body);
    return c.json({ prescription: p });
  },
);

practiceRoutes.delete(
  "/prescriptions/:itemId",
  requireAuth,
  requireScope("practice:write"),
  prescriptionsWriteLimit,
  zValidator("param", itemIdParam),
  async (c) => {
    const ok = await deletePrescription(c.req.valid("param").itemId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);

// ----- Locations -----

practiceRoutes.get("/locations", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const locations = await listLocations(userId);
  return c.json({ locations });
});

practiceRoutes.post(
  "/locations",
  requireAuth,
  requireScope("practice:write"),
  locationsWriteLimit,
  zValidator("json", z.object({ name: z.string().min(1).max(120) })),
  async (c) => {
    const userId = c.get("userId") as string;
    const { name } = c.req.valid("json");
    const loc = await upsertLocation(userId, name);
    if (!loc) return c.json({ error: "Name is blank after normalization" }, 400);
    return c.json({ location: loc }, 201);
  },
);

practiceRoutes.delete(
  "/locations/:id",
  requireAuth,
  requireScope("practice:write"),
  locationsWriteLimit,
  zValidator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await deleteLocation(c.req.valid("param").id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);

// ----- Sessions -----

const sessionGenBody = z.union([
  z.object({
    categoryFilter: z.string().min(1).max(100).nullable().optional(),
    nItemsRequested: z.number().int().min(1).max(50),
    includeSolidified: z.boolean().optional().default(false),
  }),
  z.object({
    itemIds: z.array(z.string().uuid()).min(1).max(50),
  }),
]);

practiceRoutes.post(
  "/sessions",
  requireAuth,
  requireScope("practice:write"),
  sessionsWriteLimit,
  zValidator("json", sessionGenBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const body = c.req.valid("json");

    let picked: { itemId: string }[];

    if ("itemIds" in body) {
      picked = [];
      for (const itemId of body.itemIds) {
        const p = await getPrescription(itemId);
        if (!p) return c.json({ error: `Item ${itemId} has no prescription` }, 400);
        picked.push({ itemId });
      }
    } else {
      const items = await generateSessionItems({
        userId,
        categoryFilter: body.categoryFilter ?? null,
        n: body.nItemsRequested,
        includeSolidified: body.includeSolidified ?? false,
      });
      if (items.length === 0) {
        return c.json({ error: "no_items_match", available: 0, requested: body.nItemsRequested }, 422);
      }
      picked = items.map((it) => ({ itemId: it.itemId }));
    }

    const { session, itemIds } = await createSession({
      userId,
      categoryFilter: "categoryFilter" in body ? body.categoryFilter ?? null : null,
      nItemsRequested: "itemIds" in body ? body.itemIds.length : body.nItemsRequested,
      items: picked,
    });

    return c.json({ session, itemIds }, 201);
  },
);

// Validate the preview query up front so a malformed ?n (e.g. ?n=abc, ?n=-5,
// ?n=999) is rejected with 400 rather than silently coerced to the default 5 —
// mirrors the loans/journal list-query hardening (SHAN-372/373). Absent ?n keeps
// the default of 5. include_solidified stays a passthrough string (the frontend
// only ever sends "true"); anything other than "true" reads as false as before.
const previewQuery = z.object({
  category: z.string().max(100).optional(),
  n: z.coerce.number().int().min(1).max(50).optional(),
  include_solidified: z.string().optional(),
});

practiceRoutes.get("/sessions/preview", requireAuth, zValidator("query", previewQuery), async (c) => {
  const userId = c.get("userId") as string;
  const { category, n, include_solidified } = c.req.valid("query");
  const items = await generateSessionItems({
    userId,
    categoryFilter: category ?? null,
    n: n ?? 5,
    includeSolidified: include_solidified === "true",
  });
  return c.json({ items });
});

practiceRoutes.get(
  "/sessions/:id",
  requireAuth,
  zValidator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const userId = c.get("userId") as string;
    const session = await getSessionById(c.req.valid("param").id, userId);
    if (!session) return c.json({ error: "Not found" }, 404);
    const items = await listItemsForSession(session.id);
    return c.json({ session, items });
  },
);

practiceRoutes.get("/sessions", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const sessions = await listSessions(userId);
  return c.json({ sessions });
});

practiceRoutes.patch(
  "/sessions/:id",
  requireAuth,
  requireScope("practice:write"),
  sessionsWriteLimit,
  zValidator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await markSessionCompleted(c.req.valid("param").id, userId);
    return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  },
);

practiceRoutes.delete(
  "/sessions/:id",
  requireAuth,
  requireScope("practice:write"),
  sessionsWriteLimit,
  zValidator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await deleteSession(c.req.valid("param").id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);

// ----- Session items (sync endpoint) -----

const syncBody = z.object({
  timerState: z.unknown().optional(),
  setsCompleted: z.number().int().min(0).max(500).optional(),
  locationId: z.string().uuid().nullable().optional(),
  locationName: z.string().min(1).max(120).nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
});

practiceRoutes.post(
  "/session-items/:id/sync",
  requireAuth,
  requireScope("practice:write"),
  sessionItemsSyncLimit,
  zValidator("param", z.object({ id: z.string().uuid() })),
  zValidator("json", syncBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const body = c.req.valid("json");
    const patch: any = { ...body };
    if (patch.completedAt !== undefined && patch.completedAt !== null) patch.completedAt = new Date(patch.completedAt);
    if (patch.startedAt !== undefined && patch.startedAt !== null) patch.startedAt = new Date(patch.startedAt);
    const updated = await syncSessionItem(c.req.valid("param").id, userId, patch);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ sessionItem: updated });
  },
);

// ----- Aggregations -----

practiceRoutes.get("/items", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const cat = c.req.query("category") ?? null;
  const inc = c.req.query("include_solidified") === "true";
  const items = await listPracticeableItems({ userId, categoryFilter: cat, includeSolidified: inc });
  return c.json({ items });
});

practiceRoutes.get(
  "/items/:itemId/progress",
  requireAuth,
  zValidator("param", itemIdParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const detail = await getItemProgressDetail(userId, c.req.valid("param").itemId);
    if (!detail) return c.json({ error: "Not found" }, 404);
    return c.json({ detail });
  },
);
