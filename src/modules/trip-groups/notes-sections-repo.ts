// Margin notes + collaborative sections (SHAN-283).
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tripGroupNotes, tripGroupSections, users } from "@/db/schema";
import { applyItemDelta, MAX_SECTION_ITEMS, type SectionItemDelta } from "./section-items";

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface TripGroupNote {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string | null;
  anchorType: string;
  anchorDay: number | null;
  anchorActivity: string | null;
  body: string;
  createdAt: Date;
}

const noteColumns = {
  id: tripGroupNotes.id,
  groupId: tripGroupNotes.groupId,
  authorId: tripGroupNotes.authorId,
  authorName: users.name,
  anchorType: tripGroupNotes.anchorType,
  anchorDay: tripGroupNotes.anchorDay,
  anchorActivity: tripGroupNotes.anchorActivity,
  body: tripGroupNotes.body,
  createdAt: tripGroupNotes.createdAt,
};

export async function createNote(input: {
  groupId: string;
  authorId: string;
  anchorType: "group" | "day" | "activity";
  anchorDay: number | null;
  anchorActivity: string | null;
  body: string;
}): Promise<TripGroupNote> {
  const [row] = await db
    .insert(tripGroupNotes)
    .values(input)
    .returning({ id: tripGroupNotes.id });
  const [full] = await db
    .select(noteColumns)
    .from(tripGroupNotes)
    .innerJoin(users, eq(users.id, tripGroupNotes.authorId))
    .where(eq(tripGroupNotes.id, row.id))
    .limit(1);
  return full;
}

export async function listNotes(groupId: string): Promise<TripGroupNote[]> {
  return db
    .select(noteColumns)
    .from(tripGroupNotes)
    .innerJoin(users, eq(users.id, tripGroupNotes.authorId))
    .where(eq(tripGroupNotes.groupId, groupId))
    .orderBy(asc(tripGroupNotes.createdAt));
}

export async function getNoteById(id: string): Promise<TripGroupNote | null> {
  const [row] = await db
    .select(noteColumns)
    .from(tripGroupNotes)
    .innerJoin(users, eq(users.id, tripGroupNotes.authorId))
    .where(eq(tripGroupNotes.id, id))
    .limit(1);
  return row ?? null;
}

export async function deleteNoteById(id: string): Promise<boolean> {
  const rows = await db
    .delete(tripGroupNotes)
    .where(eq(tripGroupNotes.id, id))
    .returning({ id: tripGroupNotes.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionItem {
  id: string;
  text: string;
  done: boolean;
  addedBy: string | null;
}

export interface TripGroupSection {
  id: string;
  groupId: string;
  createdBy: string;
  title: string;
  kind: string;
  items: SectionItem[];
  createdAt: Date;
  updatedAt: Date;
}

const sectionColumns = {
  id: tripGroupSections.id,
  groupId: tripGroupSections.groupId,
  createdBy: tripGroupSections.createdBy,
  title: tripGroupSections.title,
  kind: tripGroupSections.kind,
  items: tripGroupSections.items,
  createdAt: tripGroupSections.createdAt,
  updatedAt: tripGroupSections.updatedAt,
};

function toSection(row: typeof sectionColumns extends infer _ ? Record<string, unknown> : never): TripGroupSection {
  return { ...(row as Omit<TripGroupSection, "items">), items: (row.items as SectionItem[]) ?? [] };
}

export async function createSection(input: {
  groupId: string;
  createdBy: string;
  title: string;
  kind: string;
}): Promise<TripGroupSection> {
  const [row] = await db.insert(tripGroupSections).values(input).returning(sectionColumns);
  return toSection(row);
}

export async function listSections(groupId: string): Promise<TripGroupSection[]> {
  const rows = await db
    .select(sectionColumns)
    .from(tripGroupSections)
    .where(eq(tripGroupSections.groupId, groupId))
    .orderBy(desc(tripGroupSections.createdAt));
  return rows.map(toSection);
}

export async function getSectionById(id: string): Promise<TripGroupSection | null> {
  const [row] = await db
    .select(sectionColumns)
    .from(tripGroupSections)
    .where(eq(tripGroupSections.id, id))
    .limit(1);
  return row ? toSection(row) : null;
}

export async function updateSection(
  id: string,
  patch: { title?: string; items?: SectionItem[] },
): Promise<TripGroupSection | null> {
  const [row] = await db
    .update(tripGroupSections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tripGroupSections.id, id))
    .returning(sectionColumns);
  return row ? toSection(row) : null;
}

/**
 * SHAN-557: apply an item delta to the section as it is stored, under a row
 * lock. A full items list is built from whatever copy the member's tab loaded,
 * so writing it erased checks, adds and removals other members made since.
 * Returns "too_many" without writing when the merge would pass the item cap.
 */
export async function applySectionItemDelta(
  id: string,
  delta: SectionItemDelta,
  title?: string,
): Promise<TripGroupSection | "too_many" | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ items: tripGroupSections.items })
      .from(tripGroupSections)
      .where(eq(tripGroupSections.id, id))
      .for("update");
    if (!current) return null;
    const items = applyItemDelta((current.items as SectionItem[]) ?? [], delta);
    if (items.length > MAX_SECTION_ITEMS) return "too_many";
    const [row] = await tx
      .update(tripGroupSections)
      .set({ items, ...(title !== undefined ? { title } : {}), updatedAt: new Date() })
      .where(eq(tripGroupSections.id, id))
      .returning(sectionColumns);
    return row ? toSection(row) : null;
  });
}

export async function deleteSectionById(id: string): Promise<boolean> {
  const rows = await db
    .delete(tripGroupSections)
    .where(eq(tripGroupSections.id, id))
    .returning({ id: tripGroupSections.id });
  return rows.length > 0;
}
