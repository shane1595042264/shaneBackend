import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
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

const createSchema = z.object({
  borrowerName: z.string().min(1).max(255),
  amount: amountSchema,
  currency: z.string().length(3).optional(),
  description: z.string().max(2000).optional().nullable(),
});

const patchSchema = z
  .object({
    borrowerName: z.string().min(1).max(255).optional(),
    amount: amountSchema.optional(),
    currency: z.string().length(3).optional(),
    description: z.string().max(2000).optional().nullable(),
    status: z.enum(["outstanding", "repaid"]).optional(),
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
    repaidAt: row.repaidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

loansRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(loanEntries)
    .where(eq(loanEntries.userId, userId))
    .orderBy(desc(loanEntries.createdAt));
  return c.json({ entries: rows.map(serialize) });
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
