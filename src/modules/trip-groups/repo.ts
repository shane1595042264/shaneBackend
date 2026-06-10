import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  tripGroups,
  tripGroupMembers,
  tripIdeas,
  tripItinerarySuggestions,
  users,
} from "@/db/schema";
import { generateUniqueSlug } from "../trips/slug";

export interface TripGroupSummary {
  id: string;
  slug: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
  ideaCount: number;
}

export interface TripGroupMember {
  userId: string;
  name: string | null;
  role: string;
  joinedAt: Date;
}

export interface TripIdea {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAt: Date;
}

export interface TripGroupDetail {
  id: string;
  slug: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  itinerary: unknown | null;
  itineraryGeneratedAt: Date | null;
  members: TripGroupMember[];
  ideas: TripIdea[];
}

async function slugIsTaken(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tripGroups.id })
    .from(tripGroups)
    .where(eq(tripGroups.slug, slug))
    .limit(1);
  return !!row;
}

/**
 * Create a new trip group and add the creator as the first member (role:
 * owner). Returns the group row. Slug is derived from the title; on
 * collision a short suffix is appended (see trips/slug.ts).
 */
export async function createTripGroup(input: {
  ownerId: string;
  title: string;
}): Promise<{ id: string; slug: string; title: string; createdAt: Date; updatedAt: Date }> {
  const slug = await generateUniqueSlug(input.title, slugIsTaken);
  const [group] = await db
    .insert(tripGroups)
    .values({
      slug,
      ownerId: input.ownerId,
      title: input.title,
    })
    .returning();
  await db
    .insert(tripGroupMembers)
    .values({ groupId: group.id, userId: input.ownerId, role: "owner" });
  return {
    id: group.id,
    slug: group.slug,
    title: group.title,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

/**
 * List groups the user is a member of (owner or joined), newest first.
 * Member + idea counts surfaced inline for the index card UI.
 */
export async function listGroupsForUser(userId: string): Promise<TripGroupSummary[]> {
  const rows = await db
    .select({
      id: tripGroups.id,
      slug: tripGroups.slug,
      title: tripGroups.title,
      ownerId: tripGroups.ownerId,
      createdAt: tripGroups.createdAt,
      updatedAt: tripGroups.updatedAt,
    })
    .from(tripGroupMembers)
    .innerJoin(tripGroups, eq(tripGroups.id, tripGroupMembers.groupId))
    .where(eq(tripGroupMembers.userId, userId))
    .orderBy(desc(tripGroups.createdAt));

  if (rows.length === 0) return [];

  const groupIds = rows.map((r) => r.id);

  // Fan-out counts per group. Two cheap queries beat repeating subqueries
  // in the main select.
  const memberCounts = new Map<string, number>();
  const ideaCounts = new Map<string, number>();

  // Naive .length-counts. Fine for personal-site cardinality (groups in
  // the tens, members per group in single digits).
  for (const id of groupIds) {
    const ms = await db
      .select({ id: tripGroupMembers.id })
      .from(tripGroupMembers)
      .where(eq(tripGroupMembers.groupId, id));
    memberCounts.set(id, ms.length);
    const is = await db
      .select({ id: tripIdeas.id })
      .from(tripIdeas)
      .where(eq(tripIdeas.groupId, id));
    ideaCounts.set(id, is.length);
  }

  return rows.map((r) => ({
    ...r,
    memberCount: memberCounts.get(r.id) ?? 0,
    ideaCount: ideaCounts.get(r.id) ?? 0,
  }));
}

/** Lookup a group by slug. Returns the bare group row or null. */
export async function getGroupBySlug(
  slug: string,
): Promise<{
  id: string;
  slug: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  itinerary: unknown | null;
  itineraryGeneratedAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: tripGroups.id,
      slug: tripGroups.slug,
      title: tripGroups.title,
      ownerId: tripGroups.ownerId,
      createdAt: tripGroups.createdAt,
      updatedAt: tripGroups.updatedAt,
      itinerary: tripGroups.itinerary,
      itineraryGeneratedAt: tripGroups.itineraryGeneratedAt,
    })
    .from(tripGroups)
    .where(eq(tripGroups.slug, slug))
    .limit(1);
  return row ?? null;
}

/** Full detail: group row + members + ideas. Used by the detail page. */
export async function getGroupDetail(slug: string): Promise<TripGroupDetail | null> {
  const group = await getGroupBySlug(slug);
  if (!group) return null;

  const members = await db
    .select({
      userId: tripGroupMembers.userId,
      name: users.name,
      role: tripGroupMembers.role,
      joinedAt: tripGroupMembers.joinedAt,
    })
    .from(tripGroupMembers)
    .innerJoin(users, eq(users.id, tripGroupMembers.userId))
    .where(eq(tripGroupMembers.groupId, group.id))
    .orderBy(asc(tripGroupMembers.joinedAt));

  const ideas = await db
    .select({
      id: tripIdeas.id,
      groupId: tripIdeas.groupId,
      authorId: tripIdeas.authorId,
      authorName: users.name,
      body: tripIdeas.body,
      createdAt: tripIdeas.createdAt,
    })
    .from(tripIdeas)
    .innerJoin(users, eq(users.id, tripIdeas.authorId))
    .where(eq(tripIdeas.groupId, group.id))
    .orderBy(desc(tripIdeas.createdAt));

  return { ...group, members, ideas };
}

/**
 * Persist a consolidated itinerary on the group (SHAN-272). Caller is
 * responsible for shape validation (consolidator zod schema) and the
 * owner-only authorization check.
 */
export async function saveItinerary(
  groupId: string,
  itinerary: unknown,
): Promise<{ itineraryGeneratedAt: Date }> {
  const now = new Date();
  await db
    .update(tripGroups)
    .set({ itinerary, itineraryGeneratedAt: now, updatedAt: now })
    .where(eq(tripGroups.id, groupId));
  return { itineraryGeneratedAt: now };
}

/** True iff (groupId, userId) row exists in trip_group_members. */
export async function isMember(groupId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tripGroupMembers.id })
    .from(tripGroupMembers)
    .where(and(eq(tripGroupMembers.groupId, groupId), eq(tripGroupMembers.userId, userId)))
    .limit(1);
  return !!row;
}

/**
 * Add userId as a member of groupId. Idempotent: if the user is already
 * a member the unique constraint surfaces and we return `false`. Otherwise
 * `true`. Role defaults to "member" — owner-role rows are only created
 * by `createTripGroup`.
 */
export async function addMember(groupId: string, userId: string): Promise<boolean> {
  try {
    await db
      .insert(tripGroupMembers)
      .values({ groupId, userId, role: "member" });
    return true;
  } catch (err: unknown) {
    // unique constraint violation → already a member
    const msg = (err as { message?: string })?.message ?? "";
    if (msg.includes("trip_group_members_group_user_unique") || msg.includes("duplicate key")) {
      return false;
    }
    throw err;
  }
}

/** Post a new idea. Caller must verify membership before calling. */
export async function createIdea(input: {
  groupId: string;
  authorId: string;
  body: string;
}): Promise<TripIdea> {
  const [row] = await db
    .insert(tripIdeas)
    .values({
      groupId: input.groupId,
      authorId: input.authorId,
      body: input.body,
    })
    .returning();
  // Pull author name in a second query — cheap and avoids a complicated
  // returning clause.
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.authorId));
  return {
    id: row.id,
    groupId: row.groupId,
    authorId: row.authorId,
    authorName: u?.name ?? null,
    body: row.body,
    createdAt: row.createdAt,
  };
}

/**
 * Delete an idea by id. Authorization (must be author) is handled in the
 * route; this just performs the delete and reports whether a row matched.
 */
export async function deleteIdeaById(id: string, authorId: string): Promise<boolean> {
  const result = await db
    .delete(tripIdeas)
    .where(and(eq(tripIdeas.id, id), eq(tripIdeas.authorId, authorId)))
    .returning({ id: tripIdeas.id });
  return result.length > 0;
}

/** Lookup an idea by id (for authorization checks). */
export async function getIdeaById(
  id: string,
): Promise<{ id: string; groupId: string; authorId: string } | null> {
  const [row] = await db
    .select({ id: tripIdeas.id, groupId: tripIdeas.groupId, authorId: tripIdeas.authorId })
    .from(tripIdeas)
    .where(eq(tripIdeas.id, id))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Itinerary suggestions (SHAN-273, Phase 4)
// ---------------------------------------------------------------------------

export interface ItinerarySuggestion {
  id: string;
  groupId: string;
  authorId: string;
  authorName: string | null;
  itinerary: unknown;
  changedDays: number[];
  note: string | null;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

/** Insert a pending suggestion. Caller validates shape + membership. */
export async function createSuggestion(input: {
  groupId: string;
  authorId: string;
  itinerary: unknown;
  changedDays: number[];
  note: string | null;
}): Promise<ItinerarySuggestion> {
  const [row] = await db
    .insert(tripItinerarySuggestions)
    .values({
      groupId: input.groupId,
      authorId: input.authorId,
      itinerary: input.itinerary,
      changedDays: input.changedDays,
      note: input.note,
    })
    .returning();
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.authorId));
  return {
    id: row.id,
    groupId: row.groupId,
    authorId: row.authorId,
    authorName: u?.name ?? null,
    itinerary: row.itinerary,
    changedDays: (row.changedDays as number[]) ?? [],
    note: row.note,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  };
}

/** All suggestions for a group, newest first. Tiny cardinality, no paging. */
export async function listSuggestions(groupId: string): Promise<ItinerarySuggestion[]> {
  const rows = await db
    .select({
      id: tripItinerarySuggestions.id,
      groupId: tripItinerarySuggestions.groupId,
      authorId: tripItinerarySuggestions.authorId,
      authorName: users.name,
      itinerary: tripItinerarySuggestions.itinerary,
      changedDays: tripItinerarySuggestions.changedDays,
      note: tripItinerarySuggestions.note,
      status: tripItinerarySuggestions.status,
      createdAt: tripItinerarySuggestions.createdAt,
      resolvedAt: tripItinerarySuggestions.resolvedAt,
      resolvedBy: tripItinerarySuggestions.resolvedBy,
    })
    .from(tripItinerarySuggestions)
    .innerJoin(users, eq(users.id, tripItinerarySuggestions.authorId))
    .where(eq(tripItinerarySuggestions.groupId, groupId))
    .orderBy(desc(tripItinerarySuggestions.createdAt));
  return rows.map((r) => ({ ...r, changedDays: (r.changedDays as number[]) ?? [] }));
}

/** Lookup one suggestion (authorization checks live in the route). */
export async function getSuggestionById(id: string): Promise<ItinerarySuggestion | null> {
  const rows = await db
    .select({
      id: tripItinerarySuggestions.id,
      groupId: tripItinerarySuggestions.groupId,
      authorId: tripItinerarySuggestions.authorId,
      authorName: users.name,
      itinerary: tripItinerarySuggestions.itinerary,
      changedDays: tripItinerarySuggestions.changedDays,
      note: tripItinerarySuggestions.note,
      status: tripItinerarySuggestions.status,
      createdAt: tripItinerarySuggestions.createdAt,
      resolvedAt: tripItinerarySuggestions.resolvedAt,
      resolvedBy: tripItinerarySuggestions.resolvedBy,
    })
    .from(tripItinerarySuggestions)
    .innerJoin(users, eq(users.id, tripItinerarySuggestions.authorId))
    .where(eq(tripItinerarySuggestions.id, id))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, changedDays: (r.changedDays as number[]) ?? [] } : null;
}

/**
 * Resolve a pending suggestion. The status guard in the WHERE clause makes
 * double-resolution a no-op race-safely: returns null if the row was not
 * pending (already resolved or missing).
 */
export async function resolveSuggestion(
  id: string,
  status: "approved" | "rejected",
  resolvedBy: string,
): Promise<{ id: string; status: string; resolvedAt: Date } | null> {
  const now = new Date();
  const [row] = await db
    .update(tripItinerarySuggestions)
    .set({ status, resolvedAt: now, resolvedBy })
    .where(
      and(eq(tripItinerarySuggestions.id, id), eq(tripItinerarySuggestions.status, "pending")),
    )
    .returning({ id: tripItinerarySuggestions.id, status: tripItinerarySuggestions.status });
  return row ? { ...row, resolvedAt: now } : null;
}

/**
 * Wipe the itinerary (SHAN-285). Owner-only reset for when the idea inbox
 * was cleaned up and the next consolidation should start fresh instead of
 * upserting onto the old draft.
 */
export async function clearItinerary(groupId: string): Promise<void> {
  await db
    .update(tripGroups)
    .set({ itinerary: null, itineraryGeneratedAt: null, updatedAt: new Date() })
    .where(eq(tripGroups.id, groupId));
}
