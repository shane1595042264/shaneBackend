// Small helpers for reading per-user preferences that route handlers need
// at write time (e.g. snapshotting the author's timezone on a journal
// create). Kept here so callers don't have to know the users table column
// names — they just ask the auth module for the value.

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";

/** Fallback when a user has no row or no timezone set (shouldn't happen post-migration). */
export const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Look up the user's saved IANA timezone. Returns DEFAULT_TIMEZONE if the
 * user has no row (e.g. transient race) so callers never have to handle
 * null. Adds one indexed SELECT per call — fine on write endpoints.
 */
export async function getUserTimezone(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * Look up the user's universal tea PIN (SHAN-320). Returns null when unset.
 * The tea-entries GET handler calls this on the per-entry PIN fallback path,
 * so it's a hot lookup on PIN-gated reads — one indexed select by PK.
 */
export async function getUniversalTeaPin(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ pin: users.universalTeaPin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.pin ?? null;
}

/** Persist (set or rotate) the universal tea PIN. Caller must have validated 4 digits. */
export async function setUniversalTeaPin(userId: string, pin: string): Promise<void> {
  await db
    .update(users)
    .set({ universalTeaPin: pin, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Clear the universal tea PIN. After this, only per-entry PINs unlock entries. */
export async function clearUniversalTeaPin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ universalTeaPin: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
