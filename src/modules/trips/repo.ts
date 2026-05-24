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

export async function deleteTripBySlug(slug: string, ownerId: string): Promise<boolean> {
  const result = await db
    .delete(trips)
    .where(and(eq(trips.slug, slug), eq(trips.ownerId, ownerId)))
    .returning({ id: trips.id });
  return result.length > 0;
}
