import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/**
 * Fail-closed shared-secret guard for machine-only endpoints.
 *
 * Access requires `envVar` to be set in the environment AND a matching
 * `Authorization: Bearer <token>` header. If the variable is unset the guard
 * denies access (secure by default). The compare is constant-time; buffers of
 * unequal length short-circuit to false because timingSafeEqual throws on
 * length mismatch.
 *
 * Inline checks of the form `if (token && header !== ...)` are fail-OPEN: they
 * skip the guard entirely whenever the variable is unset. That left the admin
 * endpoints open in prod (SHAN-345) and WeChat ingest writable by anyone
 * (SHAN-572). Use this helper instead.
 */
export function isBearerAuthed(c: Context, envVar: string): boolean {
  const expected = process.env[envVar];
  if (!expected) return false;
  const a = Buffer.from(c.req.header("Authorization") ?? "");
  const b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Guard for the admin/debug endpoints; set ADMIN_TOKEN in Railway to enable them. */
export function isAdminAuthed(c: Context): boolean {
  return isBearerAuthed(c, "ADMIN_TOKEN");
}
