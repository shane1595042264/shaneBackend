import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, users } from "@/db/schema";
import { generateUniqueSlug } from "./slug";

export interface TripListItem {
  id: string;
  slug: string;
  title: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TripFull extends TripListItem {
  html: string;
  sourceFilename: string | null;
}

async function slugIsTaken(slug: string): Promise<boolean> {
  const [row] = await db.select({ id: trips.id }).from(trips).where(eq(trips.slug, slug)).limit(1);
  return !!row;
}

/**
 * Resolve the display name for a trip's owner. Read paths (listTrips,
 * getTripBySlug) get this via a LEFT JOIN; the write paths below can't join
 * on `.returning()`, so they call this to honor the TripFull contract instead
 * of hardcoding null. Anonymous trips (no ownerId) short-circuit with no query.
 */
async function ownerNameFor(ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, ownerId)).limit(1);
  return row?.name ?? null;
}

export async function createTrip(input: {
  ownerId: string | null;
  title: string | null;
  html: string;
  sourceFilename: string | null;
}): Promise<TripFull> {
  const slug = await generateUniqueSlug(input.title, slugIsTaken);
  const [row] = await db
    .insert(trips)
    .values({
      slug,
      ownerId: input.ownerId,
      title: input.title,
      html: input.html,
      sourceFilename: input.sourceFilename,
    })
    .returning();
  return { ...row, ownerName: await ownerNameFor(row.ownerId) };
}

/**
 * List trip metadata (no html), newest first.
 *
 * Pagination is opt-in and keyset-based, mirroring the journal
 * /entries pattern:
 *  - No opts → return every trip (unchanged legacy behavior).
 *  - opts.limit → return at most `limit` rows.
 *  - opts.cursor (ISO createdAt of the last row seen) → return only rows
 *    strictly older than the cursor, so pages don't overlap.
 * An invalid cursor string is ignored rather than throwing (the route
 * validator already guards shape; this is defense in depth).
 */
export async function listTrips(opts: { limit?: number; cursor?: string } = {}): Promise<TripListItem[]> {
  const conditions = [];
  if (opts.cursor) {
    const cursorDate = new Date(opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(trips.createdAt, cursorDate));
    }
  }

  const query = db
    .select({
      id: trips.id,
      slug: trips.slug,
      title: trips.title,
      ownerId: trips.ownerId,
      ownerName: users.name,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.ownerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(trips.createdAt));

  return opts.limit ? await query.limit(opts.limit) : await query;
}

export async function getTripBySlug(slug: string): Promise<TripFull | null> {
  const [row] = await db
    .select({
      id: trips.id,
      slug: trips.slug,
      title: trips.title,
      html: trips.html,
      sourceFilename: trips.sourceFilename,
      ownerId: trips.ownerId,
      ownerName: users.name,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.ownerId))
    .where(eq(trips.slug, slug))
    .limit(1);
  return row ?? null;
}

/**
 * Update by slug — no ownership check (trips are a free-for-all). Only
 * fields present in `patch` are written; missing fields are left alone.
 * Returns null when the slug doesn't exist.
 */
export async function updateTripBySlug(
  slug: string,
  patch: { html?: string; title?: string | null; sourceFilename?: string | null },
): Promise<TripFull | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.html !== undefined) set.html = patch.html;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.sourceFilename !== undefined) set.sourceFilename = patch.sourceFilename;

  const [row] = await db
    .update(trips)
    .set(set)
    .where(eq(trips.slug, slug))
    .returning();
  if (!row) return null;
  return { ...row, ownerName: await ownerNameFor(row.ownerId) };
}

/** Delete by slug — no ownership check. Anyone can nuke any trip. */
export async function deleteTripBySlug(slug: string): Promise<boolean> {
  const result = await db
    .delete(trips)
    .where(eq(trips.slug, slug))
    .returning({ id: trips.id });
  return result.length > 0;
}
