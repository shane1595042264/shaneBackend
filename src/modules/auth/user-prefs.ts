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
