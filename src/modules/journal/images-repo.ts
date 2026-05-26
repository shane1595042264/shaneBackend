// src/modules/journal/images-repo.ts
//
// Inline image storage backing the markdown editor's clipboard-paste feature.
// One row per image: bytes live in journal_images.data (bytea), and the editor
// embeds ![](/api/journal/images/<id>) into the surrounding markdown.
import { eq } from "drizzle-orm";
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
