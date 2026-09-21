import { createHash } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, users } from "@/db/schema";
import { keysetBefore, parseKeysetCursor } from "@/modules/shared/keyset";
import { generateUniqueSlug } from "./slug";

export interface TripListItem {
  id: string;
  slug: string;
  title: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TripFull extends TripListItem {
  html: string;
  sourceFilename: string | null;
}

async function slugIsTaken(slug: string): Promise<boolean> {
  const [row] = await db.select({ id: trips.id }).from(trips).where(eq(trips.slug, slug)).limit(1);
  return !!row;
}

/**
 * Resolve the display name for a trip's owner. Read paths (listTrips,
 * getTripBySlug) get this via a LEFT JOIN; the write paths below can't join
 * on `.returning()`, so they call this to honor the TripFull contract instead
 * of hardcoding null. Anonymous trips (no ownerId) short-circuit with no query.
 */
async function ownerNameFor(ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, ownerId)).limit(1);
  return row?.name ?? null;
}

export interface DuplicateTrip {
  slug: string;
  title: string | null;
  createdAt: Date;
}

/**
 * Normalize a title the way duplicate detection compares them: trimmed,
 * internal whitespace collapsed, lowercased. Exported so the SQL side and any
 * caller that wants to explain a match agree on one definition.
 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find an existing trip that the given upload is a duplicate of (SHAN-514).
 *
 * Two trips count as the same trip when either holds:
 *  - their normalized titles are equal — the ordinary "dropped the same file
 *    on /trips/new twice" case, where `<title>` extraction yields the same
 *    string both times;
 *  - their HTML is byte-identical — catches the same re-upload when the
 *    second one carried a title override, so the titles differ but the
 *    itinerary does not.
 *
 * Returns the OLDEST match, so the caller points the uploader at the original
 * rather than at whichever copy happens to sort first. A null title never
 * matches on the title arm: "untitled" is not an identity.
 *
 * Scaling note: `md5(html)` is evaluated per row, so this is O(corpus bytes)
 * per upload. That is nothing for a personal site holding a handful of trips.
 * If the table ever grows, store the digest in a column at insert time and
 * compare against that instead of recomputing here.
 */
export async function findDuplicateTrip(input: {
  title: string | null;
  html: string;
}): Promise<DuplicateTrip | null> {
  const htmlHash = createHash("md5").update(input.html, "utf8").digest("hex");

  const matches = [sql`md5(${trips.html}) = ${htmlHash}`];
  if (input.title !== null) {
    const normalized = normalizeTitle(input.title);
    // Mirror normalizeTitle() in SQL so the comparison is done by the DB
    // rather than by pulling every title into memory. The whitespace class is
    // spelled `[[:space:]]` rather than `\s` on purpose: drizzle's `sql` tag
    // reads the COOKED template strings, so a lone backslash would be eaten
    // and leave a regex that collapses runs of the letter "s".
    if (normalized) {
      matches.push(
        sql`lower(btrim(regexp_replace(${trips.title}, '[[:space:]]+', ' ', 'g'))) = ${normalized}`,
      );
    }
  }

  const [row] = await db
    .select({ slug: trips.slug, title: trips.title, createdAt: trips.createdAt })
    .from(trips)
    .where(or(...matches))
    .orderBy(asc(trips.createdAt), asc(trips.id))
    .limit(1);

  return row ?? null;
}

export async function createTrip(input: {
  ownerId: string | null;
  title: string | null;
  html: string;
  sourceFilename: string | null;
}): Promise<TripFull> {
  const slug = await generateUniqueSlug(input.title, slugIsTaken);
  const [row] = await db
    .insert(trips)
    .values({
      slug,
      ownerId: input.ownerId,
      title: input.title,
      html: input.html,
      sourceFilename: input.sourceFilename,
    })
    .returning();
  return { ...row, ownerName: await ownerNameFor(row.ownerId) };
}

/**
 * List trip metadata (no html), newest first.
 *
 * Pagination is opt-in and keyset-based, mirroring the journal
 * /entries pattern:
 *  - No opts → return every trip (unchanged legacy behavior).
 *  - opts.limit → return at most `limit` rows.
 *  - opts.cursor (compound keyset cursor for the last row seen) → return only
 *    rows strictly after it, so pages neither overlap nor skip.
 * An invalid cursor string is ignored rather than throwing (the route
 * validator already guards shape; this is defense in depth).
 */
export async function listTrips(opts: { limit?: number; cursor?: string } = {}): Promise<TripListItem[]> {
  const conditions = [];
  const cursor = parseKeysetCursor(opts.cursor);
  if (cursor) conditions.push(keysetBefore(trips.createdAt, trips.id, cursor));

  const query = db
    .select({
      id: trips.id,
      slug: trips.slug,
      title: trips.title,
      ownerId: trips.ownerId,
      ownerName: users.name,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.ownerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(trips.createdAt), desc(trips.id));

  return opts.limit ? await query.limit(opts.limit) : await query;
}

export async function getTripBySlug(slug: string): Promise<TripFull | null> {
  const [row] = await db
    .select({
      id: trips.id,
      slug: trips.slug,
      title: trips.title,
      html: trips.html,
      sourceFilename: trips.sourceFilename,
      ownerId: trips.ownerId,
      ownerName: users.name,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.ownerId))
    .where(eq(trips.slug, slug))
    .limit(1);
  return row ?? null;
}

/**
 * Update by slug — no ownership check (trips are a free-for-all). Only
 * fields present in `patch` are written; missing fields are left alone.
 * Returns null when the slug doesn't exist.
 */
export async function updateTripBySlug(
  slug: string,
  patch: { html?: string; title?: string | null; sourceFilename?: string | null },
): Promise<TripFull | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.html !== undefined) set.html = patch.html;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.sourceFilename !== undefined) set.sourceFilename = patch.sourceFilename;

  const [row] = await db
    .update(trips)
    .set(set)
    .where(eq(trips.slug, slug))
    .returning();
  if (!row) return null;
  return { ...row, ownerName: await ownerNameFor(row.ownerId) };
}

/** Delete by slug — no ownership check. Anyone can nuke any trip. */
export async function deleteTripBySlug(slug: string): Promise<boolean> {
  const result = await db
    .delete(trips)
    .where(eq(trips.slug, slug))
    .returning({ id: trips.id });
  return result.length > 0;
}
