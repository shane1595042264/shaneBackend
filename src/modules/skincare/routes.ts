import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import {
  createSkincareProduct,
  deleteSkincareProduct,
  listSkincareProducts,
  reorderSkincareProducts,
  updateSkincareProduct,
  type SkincareProductRow,
} from "./repo";
import { searchProducts } from "./search";

// Per-PAT 60s rolling write limit. JWT browser sessions bypass. Distinct
// bucket so a busy skincare updater doesn't lock out their journal/tea writes.
const skincareWriteLimit = createPATRateLimit({
  bucket: "skincare-write",
  limitPerMinute: 60,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const skincareRoutes = new Hono<Vars>();

const timeOfDaySchema = z.enum(["morning", "night"]);
const idParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  timeOfDay: timeOfDaySchema,
  name: z.string().min(1).max(255),
  brand: z.string().max(255).optional().nullable(),
  imageUrl: z.string().url().max(2048).optional().nullable(),
});

const patchBody = z
  .object({
    timeOfDay: timeOfDaySchema.optional(),
    name: z.string().min(1).max(255).optional(),
    brand: z.string().max(255).optional().nullable(),
    imageUrl: z.string().url().max(2048).optional().nullable(),
  })
  .refine(
    (b) =>
      b.timeOfDay !== undefined ||
      b.name !== undefined ||
      b.brand !== undefined ||
      b.imageUrl !== undefined,
    { message: "At least one field is required" },
  );

const reorderBody = z.object({
  timeOfDay: timeOfDaySchema,
  // Full ordered id list for the routine; positions are assigned by index.
  orderedIds: z.array(z.string().uuid()).min(1).max(100),
});

const searchQuery = z.object({
  q: z.string().trim().min(2).max(100),
});

function serialize(row: SkincareProductRow) {
  return {
    id: row.id,
    timeOfDay: row.timeOfDay,
    name: row.name,
    brand: row.brand,
    imageUrl: row.imageUrl,
    position: row.position,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Owner-scoped read: the two routines, each ordered by position. `startedAt`
// on each product is the streak/timer anchor the frontend renders "Day N"
// from. There is no public read — knowing the id isn't a gate here.
skincareRoutes.get("/", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const rows = await listSkincareProducts(userId);
  const morning = rows.filter((r) => r.timeOfDay === "morning").map(serialize);
  const night = rows.filter((r) => r.timeOfDay === "night").map(serialize);
  return c.json({ morning, night });
});

// Product-search autofill for the add form. Read-only proxy to Open Beauty
// Facts (see ./search). requireAuth (not requireScope) — it's a read, and the
// browser typeahead runs on a JWT session. Always 200 with a list; the proxy
// swallows upstream errors and returns [] so the form degrades to manual entry.
skincareRoutes.get(
  "/search",
  requireAuth,
  zValidator("query", searchQuery),
  async (c) => {
    const { q } = c.req.valid("query");
    const results = await searchProducts(q);
    return c.json({ results });
  },
);

skincareRoutes.post(
  "/",
  requireAuth,
  requireScope("entries:write"),
  skincareWriteLimit,
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { timeOfDay, name, brand, imageUrl } = c.req.valid("json");
    const row = await createSkincareProduct({ userId, timeOfDay, name, brand, imageUrl });
    return c.json({ product: serialize(row) }, 201);
  },
);

// Reorder must be declared before "/:id" so "reorder" isn't captured as an id
// (it wouldn't be — the id param is uuid-validated — but keeping the static
// route first avoids any ambiguity).
skincareRoutes.post(
  "/reorder",
  requireAuth,
  requireScope("entries:write"),
  skincareWriteLimit,
  zValidator("json", reorderBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { timeOfDay, orderedIds } = c.req.valid("json");
    // Reject duplicate ids up front — otherwise a repeated id would collapse
    // two positions and silently drop a product from the routine.
    if (new Set(orderedIds).size !== orderedIds.length) {
      return c.json({ error: "orderedIds contains duplicates" }, 400);
    }
    const moved = await reorderSkincareProducts(userId, timeOfDay, orderedIds);
    // Every id must map to one of the caller's products in this routine. A
    // short count means the client sent a stale/foreign id — reject rather
    // than persist a partial reorder.
    if (moved !== orderedIds.length) {
      return c.json(
        { error: "orderedIds must be exactly the products in this routine" },
        400,
      );
    }
    return c.json({ reordered: moved });
  },
);

skincareRoutes.patch(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  skincareWriteLimit,
  zValidator("param", idParam),
  zValidator("json", patchBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const row = await updateSkincareProduct(id, userId, patch);
    if (!row) return c.json({ error: "Not found or not owner" }, 404);
    return c.json({ product: serialize(row) });
  },
);

skincareRoutes.delete(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  skincareWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteSkincareProduct(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not owner" }, 404);
  },
);
