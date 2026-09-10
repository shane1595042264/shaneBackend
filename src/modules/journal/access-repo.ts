// src/modules/journal/access-repo.ts
//
// Membership + "request access" model for the invite-only journal
// (SHAN-474, Phase 1 of SHAN-472).
//
// Phase 1 only *records* access — the journal read routes are still public.
// Phase 2 flips them to require `hasJournalAccess`, once the frontend can
// render the Google-Docs-style request screen instead of an error.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalAccess, journalAccessRequests, users } from "@/db/schema";

export type JournalRole = "owner" | "member";
export type RequestStatus = "pending" | "approved" | "rejected";

export type JournalAccessState = {
  role: JournalRole | null;
  requestStatus: RequestStatus | null;
  requestMessage: string | null;
};

/**
 * The one account that always owns the journal. Configurable so a future
 * hand-off does not need a migration, but it deliberately has a hard-coded
 * default: an unset env var must not leave the journal ownerless, because
 * then nobody could ever approve a request.
 */
export function ownerEmail(): string {
  return (process.env.JOURNAL_OWNER_EMAIL || "a1595042264@gmail.com").trim().toLowerCase();
}

/**
 * Ensure the configured owner has an owner row. Called from getAccessFor so
 * the membership table self-heals: even on a fresh database, the first time
 * Shane loads the journal he is the owner and can approve everyone else.
 */
async function ensureOwnerRow(userId: string): Promise<void> {
  await db
    .insert(journalAccess)
    .values({ userId, role: "owner", grantedBy: null })
    .onConflictDoUpdate({
      target: journalAccess.userId,
      set: { role: "owner" },
    });
}

export async function getAccessFor(userId: string | null): Promise<JournalAccessState> {
  if (!userId) return { role: null, requestStatus: null, requestMessage: null };

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return { role: null, requestStatus: null, requestMessage: null };

  if (user.email.trim().toLowerCase() === ownerEmail()) {
    await ensureOwnerRow(userId);
    return { role: "owner", requestStatus: null, requestMessage: null };
  }

  const [access] = await db
    .select({ role: journalAccess.role })
    .from(journalAccess)
    .where(eq(journalAccess.userId, userId));
  if (access) {
    return {
      role: access.role === "owner" ? "owner" : "member",
      requestStatus: null,
      requestMessage: null,
    };
  }

  const [request] = await db
    .select({ status: journalAccessRequests.status, message: journalAccessRequests.message })
    .from(journalAccessRequests)
    .where(eq(journalAccessRequests.userId, userId));

  return {
    role: null,
    requestStatus: (request?.status as RequestStatus | undefined) ?? null,
    requestMessage: request?.message ?? null,
  };
}

export async function isOwner(userId: string | null): Promise<boolean> {
  return (await getAccessFor(userId)).role === "owner";
}

export async function hasJournalAccess(userId: string | null): Promise<boolean> {
  return (await getAccessFor(userId)).role !== null;
}

// ------------------------------------------------------------------
// members
// ------------------------------------------------------------------

export async function listMembers() {
  // Column refs stay inside the function: this module is imported (via
  // access-routes) by journal/routes.ts, whose route tests mock @/db/schema
  // with only the tables they exercise. A module-level `journalAccess.userId`
  // would throw at import time for all of them.
  return db
    .select({
      userId: journalAccess.userId,
      role: journalAccess.role,
      grantedBy: journalAccess.grantedBy,
      createdAt: journalAccess.createdAt,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(journalAccess)
    .leftJoin(users, eq(users.id, journalAccess.userId))
    // Owner first ("owner" > "member" lexically), then oldest grant first so
    // the list reads like a history.
    .orderBy(desc(journalAccess.role), asc(journalAccess.createdAt));
}

/**
 * Invite by email. Returns null when no user has ever signed in with that
 * address — we deliberately do NOT pre-create a user row, because identity
 * comes from Google OAuth and a placeholder would collide on google_id.
 */
export async function grantAccessByEmail(email: string, grantedBy: string) {
  const normalized = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`);
  if (!user) return null;

  // One transaction so an invite can never leave a settled request without a
  // membership row (or the reverse).
  await db.transaction(async (tx) => {
    await tx
      .insert(journalAccess)
      .values({ userId: user.id, role: "member", grantedBy })
      .onConflictDoNothing({ target: journalAccess.userId });

    // An invite settles any outstanding request from the same person, so the
    // owner does not see a pending row for someone who already has access.
    await tx
      .update(journalAccessRequests)
      .set({
        status: "approved",
        decidedBy: grantedBy,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(journalAccessRequests.userId, user.id), eq(journalAccessRequests.status, "pending")),
      );
  });

  return user;
}

/**
 * Revoke a membership. The `role = "member"` predicate means an owner row can
 * never be deleted through this path, so the journal cannot be orphaned.
 */
export async function revokeAccess(userId: string) {
  const rows = await db
    .delete(journalAccess)
    .where(and(eq(journalAccess.userId, userId), eq(journalAccess.role, "member")))
    .returning({ userId: journalAccess.userId });
  return rows.length > 0;
}

// ------------------------------------------------------------------
// requests
// ------------------------------------------------------------------

/**
 * Create the caller's access request, or return the existing one. A user only
 * ever has a single request row (unique on user_id); re-requesting after a
 * rejection flips it back to pending instead of stacking duplicates, and
 * re-requesting while pending is an idempotent no-op.
 */
export async function createOrRefreshRequest(userId: string, message: string | null) {
  const [existing] = await db
    .select()
    .from(journalAccessRequests)
    .where(eq(journalAccessRequests.userId, userId));

  if (existing && existing.status === "pending") return { request: existing, created: false };

  if (existing) {
    const [row] = await db
      .update(journalAccessRequests)
      .set({
        status: "pending",
        message,
        decidedBy: null,
        decidedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(journalAccessRequests.id, existing.id))
      .returning();
    return { request: row, created: false };
  }

  const [row] = await db
    .insert(journalAccessRequests)
    .values({ userId, message, status: "pending" })
    .returning();
  return { request: row, created: true };
}

export async function listRequests(status?: RequestStatus) {
  const base = db
    .select({
      id: journalAccessRequests.id,
      userId: journalAccessRequests.userId,
      message: journalAccessRequests.message,
      status: journalAccessRequests.status,
      decidedBy: journalAccessRequests.decidedBy,
      decidedAt: journalAccessRequests.decidedAt,
      createdAt: journalAccessRequests.createdAt,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(journalAccessRequests)
    .leftJoin(users, eq(users.id, journalAccessRequests.userId));

  return status
    ? base.where(eq(journalAccessRequests.status, status)).orderBy(asc(journalAccessRequests.createdAt))
    : base.orderBy(asc(journalAccessRequests.createdAt));
}

/**
 * Approve a pending request: mark it approved and add the member row. Returns
 * null when the request is missing or already decided, so the route can 404
 * rather than silently re-granting.
 */
export async function approveRequest(id: string, deciderId: string) {
  // Transactional: marking the request approved and writing the membership row
  // must land together, otherwise a mid-flight failure leaves a request the
  // owner can no longer approve for a user who still has no access.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(journalAccessRequests)
      .set({
        status: "approved",
        decidedBy: deciderId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(journalAccessRequests.id, id), eq(journalAccessRequests.status, "pending")))
      .returning();
    if (!row) return null;

    await tx
      .insert(journalAccess)
      .values({ userId: row.userId, role: "member", grantedBy: deciderId })
      .onConflictDoNothing({ target: journalAccess.userId });

    return row;
  });
}

export async function rejectRequest(id: string, deciderId: string) {
  const [row] = await db
    .update(journalAccessRequests)
    .set({ status: "rejected", decidedBy: deciderId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(journalAccessRequests.id, id), eq(journalAccessRequests.status, "pending")))
    .returning();
  return row ?? null;
}
