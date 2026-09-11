// src/modules/journal/activity-repo.ts
//
// Append-only audit trail for the journal (SHAN-483). Every mutation records
// one row; nothing ever updates or deletes one.
//
// The point of this module is attribution. A PAT request resolves to its
// owner's user id, so before this an agent write and a human write looked
// identical. We persist the api_tokens row id alongside the user id, and the
// read side joins it back to a token name, so the feed can say
// "Shane via jira-worker" instead of just "Shane".
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { apiTokens, journalActivity, users } from "@/db/schema";

export type JournalActivityAction =
  (typeof journalActivity.$inferInsert)["action"];

export type RecordActivityInput = {
  entryId: string | null;
  entryDate: string;
  action: JournalActivityAction;
  targetType: "entry" | "append" | "comment" | "suggestion";
  targetId?: string | null;
  actorId: string;
  /** api_tokens.id when the write came from a PAT; null for browser sessions. */
  actorTokenId?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * Write one audit row.
 *
 * Deliberately swallows its own errors: the audit trail is observability, not
 * business state, so a logging failure must never turn a successful append or
 * comment into a 500 for the caller. A dropped row is visible as a gap in the
 * feed; a failed user write is not acceptable.
 */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  try {
    await db.insert(journalActivity).values({
      entryId: input.entryId,
      entryDate: input.entryDate,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      actorId: input.actorId,
      actorTokenId: input.actorTokenId ?? null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error("[journal-activity] failed to record", input.action, err);
  }
}

// Built lazily inside a function, never at module scope. A top-level
// `journalActivity.id` would be evaluated at import time, and the route test
// suites mock @/db/schema partially — a missing key there throws on import and
// takes down the whole test file rather than one test (SHAN-436).
function activitySelection() {
  return {
    id: journalActivity.id,
    entryId: journalActivity.entryId,
    entryDate: journalActivity.entryDate,
    action: journalActivity.action,
    targetType: journalActivity.targetType,
    targetId: journalActivity.targetId,
    actorId: journalActivity.actorId,
    actorTokenId: journalActivity.actorTokenId,
    detail: journalActivity.detail,
    createdAt: journalActivity.createdAt,
    actorName: users.name,
    actorAvatarUrl: users.avatarUrl,
    agentName: apiTokens.name,
  };
}

export type JournalActivityRow = {
  id: string;
  entryId: string | null;
  entryDate: string;
  action: JournalActivityAction;
  targetType: string;
  targetId: string | null;
  actorId: string;
  detail: unknown;
  createdAt: Date;
  actor: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
    agent: { tokenId: string; name: string | null } | null;
  };
};

/**
 * Fold the joined user/token columns into a nested `actor`. Built field by
 * field rather than by spreading a rest object so the return type stays
 * concrete for route handlers reading `createdAt` off a row.
 */
function shape(rows: Record<string, any>[]): JournalActivityRow[] {
  return rows.map((r) => ({
    id: r.id,
    entryId: r.entryId,
    entryDate: r.entryDate,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    actorId: r.actorId,
    detail: r.detail ?? null,
    createdAt: r.createdAt,
    actor: {
      id: r.actorId,
      name: r.actorName ?? null,
      avatarUrl: r.actorAvatarUrl ?? null,
      // Null for browser sessions. When set, the action was performed by an
      // agent holding this PAT on the user's behalf — that is the whole
      // reason actor_token_id exists.
      agent: r.actorTokenId ? { tokenId: r.actorTokenId, name: r.agentName ?? null } : null,
    },
  }));
}

/**
 * Site-wide feed, newest first. Paginated by createdAt because activity rows
 * have no dense sequence and a timestamp cursor survives concurrent inserts.
 */
export async function listActivity(opts: { limit: number; cursor?: Date }) {
  const where = opts.cursor ? [lt(journalActivity.createdAt, opts.cursor)] : [];
  const rows = await db
    .select(activitySelection())
    .from(journalActivity)
    .leftJoin(users, eq(users.id, journalActivity.actorId))
    .leftJoin(apiTokens, eq(apiTokens.id, journalActivity.actorTokenId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(journalActivity.createdAt))
    .limit(opts.limit);
  return shape(rows);
}

/** Same feed, scoped to one entry. */
export async function listActivityForEntry(
  entryId: string,
  opts: { limit: number; cursor?: Date }
) {
  const where = [eq(journalActivity.entryId, entryId)];
  if (opts.cursor) where.push(lt(journalActivity.createdAt, opts.cursor));
  const rows = await db
    .select(activitySelection())
    .from(journalActivity)
    .leftJoin(users, eq(users.id, journalActivity.actorId))
    .leftJoin(apiTokens, eq(apiTokens.id, journalActivity.actorTokenId))
    .where(and(...where))
    .orderBy(desc(journalActivity.createdAt))
    .limit(opts.limit);
  return shape(rows);
}
