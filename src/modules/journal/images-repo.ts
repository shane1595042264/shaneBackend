// src/modules/journal/images-repo.ts
//
// Inline image storage backing the markdown editor's clipboard-paste feature.
// One row per image: bytes live in journal_images.data (bytea), and the editor
// embeds ![](/api/journal/images/<id>) into the surrounding markdown.
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalImages } from "@/db/schema";

export interface InsertImageInput {
  uploadedBy: string;
  mimeType: string;
  data: Buffer;
}

export interface ImageRow {
  id: string;
  mimeType: string;
  byteSize: number;
  data: Buffer;
}

export async function insertImage(input: InsertImageInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(journalImages)
    .values({
      uploadedBy: input.uploadedBy,
      mimeType: input.mimeType,
      byteSize: input.data.byteLength,
      data: input.data,
    })
    .returning({ id: journalImages.id });
  return { id: row.id };
}

export async function getImageById(id: string): Promise<ImageRow | null> {
  const [row] = await db
    .select({
      id: journalImages.id,
      mimeType: journalImages.mimeType,
      byteSize: journalImages.byteSize,
      data: journalImages.data,
    })
    .from(journalImages)
    .where(eq(journalImages.id, id))
    .limit(1);
  return row ?? null;
}

export interface UploadWindow {
  count: number;
  oldestCreatedAt: Date | null;
}

// Used by the POST /images route to enforce a per-user daily quota. One query
// returns both the row count in the trailing window and the timestamp of the
// oldest row in that window — the latter is what makes Retry-After honest:
// when the oldest row exits the 24h window, the user's count drops by one.
export async function countUploadsInWindow(
  uploadedBy: string,
  since: Date,
): Promise<UploadWindow> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldestCreatedAt: sql<Date | null>`min(${journalImages.createdAt})`,
    })
    .from(journalImages)
    .where(and(eq(journalImages.uploadedBy, uploadedBy), gte(journalImages.createdAt, since)));
  return {
    count: row?.count ?? 0,
    oldestCreatedAt: row?.oldestCreatedAt ?? null,
  };
}
