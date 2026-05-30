import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { practiceLocations } from "@/db/schema";

export interface Location {
  id: string;
  userId: string;
  name: string;
  normalized: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export function normalizeLocationName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function listLocations(userId: string): Promise<Location[]> {
  return (await db
    .select()
    .from(practiceLocations)
    .where(eq(practiceLocations.userId, userId))
    .orderBy(desc(practiceLocations.lastUsedAt))) as Location[];
}

/**
 * Upsert by (user_id, normalized) UNIQUE. Bumps last_used_at on every call.
 * Returns null when the input is blank after normalization.
 */
export async function upsertLocation(userId: string, name: string): Promise<Location | null> {
  const normalized = normalizeLocationName(name);
  if (!normalized) return null;
  const cleanName = name.trim().replace(/\s+/g, " ");
  const [row] = await db
    .insert(practiceLocations)
    .values({
      userId,
      name: cleanName,
      normalized,
      lastUsedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [practiceLocations.userId, practiceLocations.normalized],
      set: {
        lastUsedAt: new Date(),
      },
    })
    .returning();
  return row as Location;
}

export async function deleteLocation(id: string, userId: string): Promise<boolean> {
  const out = await db
    .delete(practiceLocations)
    .where(and(eq(practiceLocations.id, id), eq(practiceLocations.userId, userId)))
    .returning({ id: practiceLocations.id });
  return out.length > 0;
}
