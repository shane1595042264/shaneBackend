// src/modules/shared/edit-stamp.ts
import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * SHAN-747: the value for an `editedAt` / `updatedAt` column in an edit's SET.
 *
 * Every comment editor (and the journal append editor) lets the author click
 * edit and then Save without touching the text. Stamping `now()` regardless
 * put an "edited" tag on the comment for good, for an edit that never
 * happened. This keeps the old stamp when the new content equals the stored
 * one. It is decided inside the UPDATE itself (the right-hand side of a SET
 * reads the row as it was), so there is no read-then-write window.
 */
export function stampIfChanged(contentCol: AnyColumn, next: string, stampCol: AnyColumn): SQL {
  return sql`case when ${contentCol} is distinct from ${next} then now() else ${stampCol} end`;
}
