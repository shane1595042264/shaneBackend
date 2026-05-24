import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, users } from "@/db/schema";
import { generateUniqueSlug } from "./slug";

export interface TripListItem {
  id: string;
  slug: string;
  title: string | null;
  ownerId: string;
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

export async function createTrip(input: {
  ownerId: string;
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
  return { ...row, ownerName: null };
}

export async function listTrips(): Promise<TripListItem[]> {
  const rows = await db
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
    .orderBy(desc(trips.createdAt));
  return rows;
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
 * Owner-gated update. Only the fields present in `patch` are written —
 * a missing field is left untouched. Returns null when the slug doesn't
 * exist or the caller isn't the owner (so the route can 404 in both
 * cases without leaking which one it was).
 */
export async function updateTripBySlug(
  slug: string,
  ownerId: string,
  patch: { html?: string; title?: string | null; sourceFilename?: string | null },
): Promise<TripFull | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.html !== undefined) set.html = patch.html;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.sourceFilename !== undefined) set.sourceFilename = patch.sourceFilename;

  const [row] = await db
    .update(trips)
    .set(set)
    .where(and(eq(trips.slug, slug), eq(trips.ownerId, ownerId)))
    .returning();
  if (!row) return null;
  return { ...row, ownerName: null };
}

export async function deleteTripBySlug(slug: string, ownerId: string): Promise<boolean> {
  const result = await db
    .delete(trips)
    .where(and(eq(trips.slug, slug), eq(trips.ownerId, ownerId)))
    .returning({ id: trips.id });
  return result.length > 0;
}
