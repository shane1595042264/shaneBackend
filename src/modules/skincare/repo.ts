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

// Every product in the caller's morning + night routines, ordered by
// (timeOfDay, position) so the route can group them into the two lists
// without a second sort. Scoped to the owner — there is no public read.
export async function listSkincareProducts(
  userId: string,
): Promise<SkincareProductRow[]> {
  const rows = await db
    .select()
    .from(skincareProducts)
    .where(eq(skincareProducts.userId, userId))
    .orderBy(asc(skincareProducts.timeOfDay), asc(skincareProducts.position));
  return rows as SkincareProductRow[];
}

// Append a product to the end of the given routine. The new position is
// max(position)+1 within (userId, timeOfDay), computed in SQL so concurrent
// appends from the same user can't collide on a stale count. startedAt
// defaults to now() — the streak/timer anchor for the routine.
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
  const [row] = await db
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
}

// Owner-scoped partial update. Only the fields present in the patch are
// written. Moving a product to the other routine (timeOfDay change) drops
// it at the end of the target routine so it can't clash with an existing
// position. Returns null when no row matched (missing OR not the owner —
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
    set.position = sql`(
      select coalesce(max(${skincareProducts.position}), -1) + 1
      from ${skincareProducts}
      where ${skincareProducts.userId} = ${userId}
        and ${skincareProducts.timeOfDay} = ${patch.timeOfDay}
    )`;
  }

  const [row] = await db
    .update(skincareProducts)
    .set(set)
    .where(and(eq(skincareProducts.id, id), eq(skincareProducts.userId, userId)))
    .returning();
  return (row as SkincareProductRow | undefined) ?? null;
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

// Persist a new order for one routine. `orderedIds` is the full set of the
// caller's product ids for that timeOfDay in the desired order; each row's
// position is set to its index. Every update is scoped by (id, userId,
// timeOfDay) so an id that isn't the caller's — or belongs to the other
// routine — updates nothing. Returns the number of rows actually moved so
// the route can 400 on a mismatched id set instead of silently dropping it.
export async function reorderSkincareProducts(
  userId: string,
  timeOfDay: TimeOfDay,
  orderedIds: string[],
): Promise<number> {
  let moved = 0;
  for (let i = 0; i < orderedIds.length; i++) {
    const result = await db
      .update(skincareProducts)
      .set({ position: i, updatedAt: new Date() })
      .where(
        and(
          eq(skincareProducts.id, orderedIds[i]),
          eq(skincareProducts.userId, userId),
          eq(skincareProducts.timeOfDay, timeOfDay),
        ),
      )
      .returning({ id: skincareProducts.id });
    moved += result.length;
  }
  return moved;
}
