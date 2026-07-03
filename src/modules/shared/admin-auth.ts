import type { Context } from "hono";

/**
 * Fail-closed guard for the admin/debug endpoints.
 *
 * Access requires ADMIN_TOKEN to be set in the environment AND a matching
 * `Authorization: Bearer <token>` header. If ADMIN_TOKEN is unset the guard
 * denies access (secure by default) — set ADMIN_TOKEN in the Railway env to
 * re-enable the admin endpoints.
 *
 * The previous inline check was fail-OPEN (`if (adminToken && header !== ...)`)
 * which skipped the guard entirely whenever ADMIN_TOKEN was unset, leaving the
 * endpoints wide open in prod (SHAN-345).
 */
export function isAdminAuthed(c: Context): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  return !!adminToken && c.req.header("Authorization") === `Bearer ${adminToken}`;
}
