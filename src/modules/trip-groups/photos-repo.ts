// Photo storage for itinerary days (SHAN-275, Phase 5 of SHAN-266).
// Mirrors journal/images-repo: bytes in trip_group_photos.data (bytea) for
// user uploads; unsplash rows carry only externalUrl + attribution.
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tripGroupPhotos } from "@/db/schema";

export interface TripGroupPhotoMeta {
  id: string;
  groupId: string;
  day: number;
  uploaderId: string | null;
  source: string;
  mimeType: string | null;
  byteSize: number | null;
  externalUrl: string | null;
  attribution: string | null;
  createdAt: Date;
}

const metaColumns = {
  id: tripGroupPhotos.id,
  groupId: tripGroupPhotos.groupId,
  day: tripGroupPhotos.day,
  uploaderId: tripGroupPhotos.uploaderId,
  source: tripGroupPhotos.source,
  mimeType: tripGroupPhotos.mimeType,
  byteSize: tripGroupPhotos.byteSize,
  externalUrl: tripGroupPhotos.externalUrl,
  attribution: tripGroupPhotos.attribution,
  createdAt: tripGroupPhotos.createdAt,
};

export async function insertUserPhoto(input: {
  groupId: string;
  day: number;
  uploaderId: string;
  mimeType: string;
  data: Buffer;
}): Promise<TripGroupPhotoMeta> {
  const [row] = await db
    .insert(tripGroupPhotos)
    .values({
      groupId: input.groupId,
      day: input.day,
      uploaderId: input.uploaderId,
      source: "user",
      mimeType: input.mimeType,
      byteSize: input.data.byteLength,
      data: input.data,
    })
    .returning(metaColumns);
  return row;
}

export async function insertUnsplashPhoto(input: {
  groupId: string;
  day: number;
  externalUrl: string;
  attribution: string;
}): Promise<TripGroupPhotoMeta> {
  const [row] = await db
    .insert(tripGroupPhotos)
    .values({
      groupId: input.groupId,
      day: input.day,
      source: "unsplash",
      externalUrl: input.externalUrl,
      attribution: input.attribution,
    })
    .returning(metaColumns);
  return row;
}

/** All photo metadata for a group, day-ordered. Bytes are never included —
 * the raw route fetches them per-photo. */
export async function listPhotos(groupId: string): Promise<TripGroupPhotoMeta[]> {
  return db
    .select(metaColumns)
    .from(tripGroupPhotos)
    .where(eq(tripGroupPhotos.groupId, groupId))
    .orderBy(asc(tripGroupPhotos.day), asc(tripGroupPhotos.createdAt));
}

export async function getPhotoMeta(id: string): Promise<TripGroupPhotoMeta | null> {
  const [row] = await db
    .select(metaColumns)
    .from(tripGroupPhotos)
    .where(eq(tripGroupPhotos.id, id))
    .limit(1);
  return row ?? null;
}

export async function getPhotoBytes(
  id: string,
): Promise<{ mimeType: string | null; byteSize: number | null; data: Buffer | null } | null> {
  const [row] = await db
    .select({
      mimeType: tripGroupPhotos.mimeType,
      byteSize: tripGroupPhotos.byteSize,
      data: tripGroupPhotos.data,
    })
    .from(tripGroupPhotos)
    .where(and(eq(tripGroupPhotos.id, id), eq(tripGroupPhotos.source, "user")))
    .limit(1);
  return row ?? null;
}

export async function deletePhotoById(id: string): Promise<boolean> {
  const rows = await db
    .delete(tripGroupPhotos)
    .where(eq(tripGroupPhotos.id, id))
    .returning({ id: tripGroupPhotos.id });
  return rows.length > 0;
}
