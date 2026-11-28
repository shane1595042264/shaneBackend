import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { skincareProducts } from "@/db/schema";

export type TimeOfDay = "morning" | "night";

export interface SkincareProductRow {
  id: string;
  userId: string;
  timeOfDay: TimeOfDay;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  position: number;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// SHAN-748: every write that assigns a position in a routine (append, move
// in, reorder) reads max(position) or the routine's ids and then writes, so
// two of them overlapping under READ COMMITTED both read the same max and
// store the same position. Serializing them on a transaction-scoped advisory
// lock keyed on (user, routine) makes the waiter's next statement see the
// first writer's committed rows, as with the SHAN-591 reaction toggles.
async function lockRoutine(tx: Tx, userId: string, timeOfDay: TimeOfDay): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`skincare:${userId}:${timeOfDay}`}, 0))`,
  );
}

// Every product in the caller's morning + night routines, ordered by
// (timeOfDay, position) so the route can group them into the two lists
// without a second sort, with id breaking any tie that predates SHAN-748 so
// tied products read in the same order every time. Scoped to the owner —
// there is no public read.
export async function listSkincareProducts(
  userId: string,
): Promise<SkincareProductRow[]> {
  const rows = await db
    .select()
    .from(skincareProducts)
    .where(eq(skincareProducts.userId, userId))
    .orderBy(
      asc(skincareProducts.timeOfDay),
      asc(skincareProducts.position),
      asc(skincareProducts.id),
    );
  return rows as SkincareProductRow[];
}

// Append a product to the end of the given routine. The new position is
// max(position)+1 within (userId, timeOfDay), computed in SQL under the
// routine lock: the subquery alone does not stop two concurrent appends
// reading the same max (SHAN-748). startedAt defaults to now() — the
// streak/timer anchor for the routine.
export async function createSkincareProduct(input: {
  userId: string;
  timeOfDay: TimeOfDay;
  name: string;
  brand?: string | null;
  imageUrl?: string | null;
}): Promise<SkincareProductRow> {
  const nextPosition = sql<number>`(
    select coalesce(max(${skincareProducts.position}), -1) + 1
    from ${skincareProducts}
    where ${skincareProducts.userId} = ${input.userId}
      and ${skincareProducts.timeOfDay} = ${input.timeOfDay}
  )`;
  return db.transaction(async (tx) => {
    await lockRoutine(tx, input.userId, input.timeOfDay);
    const [row] = await tx
      .insert(skincareProducts)
      .values({
        userId: input.userId,
        timeOfDay: input.timeOfDay,
        name: input.name,
        brand: input.brand ?? null,
        imageUrl: input.imageUrl ?? null,
        position: nextPosition,
      })
      .returning();
    return row as SkincareProductRow;
  });
}

// Owner-scoped partial update. Only the fields present in the patch are
// written. Moving a product to the other routine (timeOfDay change) drops
// it at the end of the target routine so it can't clash with an existing
// position. A timeOfDay equal to the product's current routine is not a move
// (SHAN-731): the CASE keeps its position, where appending unconditionally
// sent a renamed step 1 to the bottom whenever a client echoed timeOfDay
// back. A move takes the target routine's lock (SHAN-748) so it cannot land
// on the same position as a concurrent append. Returns null when no row
// matched (missing OR not the owner —
// collapsed to a 404 in the route so existence isn't leaked).
export async function updateSkincareProduct(
  id: string,
  userId: string,
  patch: {
    name?: string;
    brand?: string | null;
    imageUrl?: string | null;
    timeOfDay?: TimeOfDay;
  },
): Promise<SkincareProductRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.brand !== undefined) set.brand = patch.brand;
  if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
  if (patch.timeOfDay !== undefined) {
    set.timeOfDay = patch.timeOfDay;
    set.position = sql`case
      when ${skincareProducts.timeOfDay} = ${patch.timeOfDay} then ${skincareProducts.position}
      else (
        select coalesce(max(${skincareProducts.position}), -1) + 1
        from ${skincareProducts}
        where ${skincareProducts.userId} = ${userId}
          and ${skincareProducts.timeOfDay} = ${patch.timeOfDay}
      )
    end`;
  }

  const write = async (q: Tx | typeof db) => {
    const [row] = await q
      .update(skincareProducts)
      .set(set)
      .where(and(eq(skincareProducts.id, id), eq(skincareProducts.userId, userId)))
      .returning();
    return (row as SkincareProductRow | undefined) ?? null;
  };
  const timeOfDay = patch.timeOfDay;
  if (timeOfDay === undefined) return write(db);
  return db.transaction(async (tx) => {
    await lockRoutine(tx, userId, timeOfDay);
    return write(tx);
  });
}

export async function deleteSkincareProduct(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(skincareProducts)
    .where(and(eq(skincareProducts.id, id), eq(skincareProducts.userId, userId)))
    .returning({ id: skincareProducts.id });
  return result.length > 0;
}

export class SkincareReorderMismatchError extends Error {
  constructor() {
    super("orderedIds must be exactly the products in this routine");
    this.name = "SkincareReorderMismatchError";
  }
}

// Persist a new order for one routine. `orderedIds` must be exactly the
// caller's product ids for that timeOfDay, in the desired order; each row's
// position is set to its index. All or nothing (SHAN-580): the routine's
// current ids are read inside the transaction and compared to `orderedIds`
// before any write, so a stale/foreign id or a missing product throws
// SkincareReorderMismatchError with nothing changed. Checking only the
// number of rows moved afterwards both committed half a reorder behind its
// 400 and let a subset through, leaving the omitted products on duplicate
// positions. It holds the routine lock (SHAN-748), so an append waits for the
// new positions and lands after them.
export async function reorderSkincareProducts(
  userId: string,
  timeOfDay: TimeOfDay,
  orderedIds: string[],
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockRoutine(tx, userId, timeOfDay);
    const current = await tx
      .select({ id: skincareProducts.id })
      .from(skincareProducts)
      .where(
        and(
          eq(skincareProducts.userId, userId),
          eq(skincareProducts.timeOfDay, timeOfDay),
        ),
      )
      .for("update");
    const currentIds = new Set(current.map((r) => r.id));
    if (
      currentIds.size !== orderedIds.length ||
      !orderedIds.every((id) => currentIds.has(id))
    ) {
      throw new SkincareReorderMismatchError();
    }
    const now = new Date();
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(skincareProducts)
        .set({ position: i, updatedAt: now })
        .where(
          and(
            eq(skincareProducts.id, orderedIds[i]),
            eq(skincareProducts.userId, userId),
            eq(skincareProducts.timeOfDay, timeOfDay),
          ),
        );
    }
    return orderedIds.length;
  });
}
