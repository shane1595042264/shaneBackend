import { getTableName, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";

/**
 * Compound keyset cursors for the newest-first list endpoints (SHAN-513).
 *
 * Every paginated list used to keyset on a bare timestamp: `lt(createdAt,
 * cursor)` under `orderBy(desc(createdAt))`. That can drop a row without any
 * error, in two ways:
 *
 *  1. Ties. `createdAt` is not unique and the ordering had no tiebreaker, so
 *     when two rows share a timestamp and one of them ends a page, the strict
 *     `lt` excludes its tied sibling from every later page. Postgres `now()`
 *     is transaction-start time, so rows written in one transaction tie
 *     exactly.
 *  2. Precision. The column is microsecond-precision `timestamptz`, but the
 *     pg driver parses it into a millisecond-precision JS `Date` and the route
 *     emitted `new Date(row.createdAt).toISOString()`. Every row created in
 *     the same millisecond as the boundary row but at an earlier microsecond
 *     fell inside the truncated gap and was skipped. Same class as SHAN-495.
 *
 * `blog/posts-repo.ts` `getAdjacentPosts` already solved both for prev/next
 * links by comparing `(published_at, id)` against a one-row subquery; this
 * generalizes that idiom to the list endpoints.
 */

/** A parsed cursor. `id` is null for the legacy bare-ISO form. */
export interface KeysetCursor {
  ts: Date;
  id: string | null;
}

const isoTimestamp = z.string().datetime();
const rowId = z.string().uuid();

/**
 * Encode the cursor for the last row of a page.
 *
 * The separator is `_` because neither an ISO-8601 timestamp nor a UUID can
 * contain one, so the two halves are unambiguous, and because it needs no
 * escaping in a query string.
 */
export function encodeKeysetCursor(ts: Date | string, id: string): string {
  const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
  return `${iso}_${id}`;
}

/**
 * Parse `<iso>_<uuid>`, or a bare `<iso>` from before this existed. Returns
 * null for anything unusable so callers can 400 rather than silently paging
 * from the top again.
 */
export function parseKeysetCursor(raw: string | undefined | null): KeysetCursor | null {
  if (!raw || typeof raw !== "string") return null;
  const sep = raw.indexOf("_");
  const isoPart = sep === -1 ? raw : raw.slice(0, sep);
  const idPart = sep === -1 ? null : raw.slice(sep + 1);

  if (!isoTimestamp.safeParse(isoPart).success) return null;
  if (idPart !== null && !rowId.safeParse(idPart).success) return null;

  const ts = new Date(isoPart);
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, id: idPart };
}

/**
 * Query-param schema for `?cursor=`. Accepts both forms and rejects anything
 * else with a 400, matching the `z.string().datetime()` behavior these
 * endpoints had before — a malformed cursor must never be swallowed, because
 * ignoring it silently resurfaces page 1.
 */
export const keysetCursorParam = z
  .string()
  .refine((raw) => parseKeysetCursor(raw) !== null, {
    message: "ISO timestamp, optionally followed by _<row id>",
  });

/**
 * Rows strictly after `cursor` in `desc(tsColumn), desc(idColumn)` order.
 * Pair it with exactly that `orderBy` — the predicate and the sort have to
 * agree or pages overlap.
 *
 * With a compound cursor the comparison is a row constructor against the
 * boundary row's *stored* key, read back by a one-row subquery so it carries
 * the microseconds the JS `Date` round-trip dropped. The subquery is aliased
 * (`k`) so its `from` shadows the outer query's rather than correlating with
 * it. `coalesce` is the degradation path: if the boundary row was deleted
 * between two pages the subquery yields NULL, which would make the whole
 * comparison NULL and end pagination early, so we fall back to the cursor's
 * own (truncated) timestamp plus the id tiebreaker.
 *
 * A legacy bare-ISO cursor has no id to tiebreak on, so it keeps the old
 * `lt` semantics exactly — in-flight cursors stay valid across the deploy.
 *
 * Identifiers are derived from the passed columns at call time rather than
 * captured at module scope: a module-level `table.col` reference throws under
 * the partial `@/db/schema` mocks the route tests use.
 */
export function keysetBefore(
  tsColumn: AnyColumn,
  idColumn: AnyColumn,
  cursor: KeysetCursor,
): SQL {
  if (!cursor.id) return lt(tsColumn, cursor.ts);

  const table = sql.identifier(getTableName(tsColumn.table));
  const tsName = sql.identifier(tsColumn.name);
  const idName = sql.identifier(idColumn.name);

  const boundaryTs = sql`coalesce((select k.${tsName} from ${table} k where k.${idName} = ${cursor.id}::uuid), ${cursor.ts}::timestamptz)`;

  return sql`(${tsColumn}, ${idColumn}) < (${boundaryTs}, ${cursor.id}::uuid)`;
}
