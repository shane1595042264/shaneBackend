import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { loanEntries } from "@/db/schema";
import { requireAuth } from "@/modules/auth/middleware";

type AuthEnv = { Variables: { userId: string } };
export const loansRoutes = new Hono<AuthEnv>();

loansRoutes.use("*", requireAuth);

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// Amount accepted as string OR number on input; persisted as text to preserve
// decimal precision (same approach as rng_decisions.price). Reject negatives
// and require ≤ 2 decimal places to keep currency math sane.
const amountSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), { message: "amount must be a non-negative decimal with up to 2 fractional digits" });

// "owed_to_me" = someone borrowed from Shane (default/legacy); "i_owe" = Shane
// owes someone else.
const directionSchema = z.enum(["owed_to_me", "i_owe"]);

const createSchema = z.object({
  borrowerName: z.string().min(1).max(255),
  amount: amountSchema,
  currency: z.string().length(3).optional(),
  description: z.string().max(2000).optional().nullable(),
  direction: directionSchema.optional(),
});

// Opt-in keyset pagination for the list endpoint. Both optional, so a bare
// GET /api/loans keeps returning the full list (nextCursor null). Mirrors the
// trips list contract (SHAN-335).
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const patchSchema = z
  .object({
    borrowerName: z.string().min(1).max(255).optional(),
    amount: amountSchema.optional(),
    currency: z.string().length(3).optional(),
    description: z.string().max(2000).optional().nullable(),
    status: z.enum(["outstanding", "repaid"]).optional(),
    direction: directionSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "no fields to update" });

function serialize(row: typeof loanEntries.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    borrowerName: row.borrowerName,
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    status: row.status,
    direction: row.direction,
    repaidAt: row.repaidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * GET /api/loans — the signed-in user's ledger, newest first.
 *
 * Opt-in keyset pagination: pass ?limit=N (1..100) and optionally
 * ?cursor=<ISO createdAt of the last item from the previous page>. With no
 * params the full list is returned and nextCursor is null (legacy behavior).
 * When a full page (length === limit) comes back, nextCursor is the createdAt
 * of the last row so the caller can fetch the next page.
 */
loansRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const userId = c.get("userId");
  const { limit, cursor } = c.req.valid("query");

  const conditions = [eq(loanEntries.userId, userId)];
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(loanEntries.createdAt, cursorDate));
    }
  }

  const query = db
    .select()
    .from(loanEntries)
    .where(and(...conditions))
    .orderBy(desc(loanEntries.createdAt));

  const rows = limit ? await query.limit(limit) : await query;
  const nextCursor =
    limit && rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null;

  return c.json({ entries: rows.map(serialize), nextCursor });
});

loansRoutes.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");
  const [row] = await db
    .insert(loanEntries)
    .values({
      userId,
      borrowerName: body.borrowerName,
      amount: body.amount,
      currency: body.currency ?? "USD",
      description: body.description ?? null,
      direction: body.direction ?? "owed_to_me",
    })
    .returning();
  return c.json({ entry: serialize(row) }, 201);
});

loansRoutes.patch(
  "/:id",
  zValidator("param", idParamSchema),
  zValidator("json", patchSchema),
  async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(loanEntries).where(eq(loanEntries.id, id));
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.userId !== userId) return c.json({ error: "Forbidden" }, 403);

    const now = new Date();
    const patch: Partial<typeof loanEntries.$inferInsert> = { updatedAt: now };
    if (body.borrowerName !== undefined) patch.borrowerName = body.borrowerName;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.currency !== undefined) patch.currency = body.currency;
    if (body.description !== undefined) patch.description = body.description;
    if (body.direction !== undefined) patch.direction = body.direction;
    if (body.status !== undefined) {
      patch.status = body.status;
      // Stamp repaidAt when transitioning to repaid; clear it on the reverse.
      if (body.status === "repaid" && existing.status !== "repaid") {
        patch.repaidAt = now;
      } else if (body.status === "outstanding") {
        patch.repaidAt = null;
      }
    }

    const [row] = await db
      .update(loanEntries)
      .set(patch)
      .where(eq(loanEntries.id, id))
      .returning();
    return c.json({ entry: serialize(row) });
  },
);

loansRoutes.delete("/:id", zValidator("param", idParamSchema), async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.valid("param");

  const [existing] = await db.select().from(loanEntries).where(eq(loanEntries.id, id));
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.userId !== userId) return c.json({ error: "Forbidden" }, 403);

  await db.delete(loanEntries).where(and(eq(loanEntries.id, id), eq(loanEntries.userId, userId)));
  return c.json({ ok: true });
});
