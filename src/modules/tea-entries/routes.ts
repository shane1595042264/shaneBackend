import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";
import { getUniversalTeaPin, getUserTimezone } from "@/modules/auth/user-prefs";
import {
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_MESSAGE,
  MAX_MARKDOWN_BODY,
  MAX_MARKDOWN_BODY_MESSAGE,
} from "@/modules/shared/validators";
import {
  createTeaEntry,
  deleteTeaEntry,
  getTeaEntryById,
  listTeaEntriesForAuthor,
  updateTeaEntry,
  verifyPin,
} from "./repo";
import {
  clearPinAttempts,
  isPinAttemptBlocked,
  recordFailedPinAttempt,
} from "./pin-rate-limit";
import { createPATRateLimit } from "@/modules/shared/rate-limit";

const noInFlightUpload = (v: string) => !containsInFlightUpload(v);

// Per-PAT 60s rolling limit on writes. JWT browser sessions bypass. Distinct
// bucket from journal's entries-write so a busy journaler doesn't lock out
// their tea entries (and vice versa).
const teaEntriesWriteLimit = createPATRateLimit({
  bucket: "tea-entries-write",
  limitPerMinute: 30,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const teaEntriesRoutes = new Hono<Vars>();

// Strict 4-digit numeric PIN. We keep this tight in both create and verify
// so an attacker can't expand the keyspace by submitting longer/alpha PINs.
const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

const createBody = z.object({
  title: z.string().max(255).optional().nullable(),
  content: z
    .string()
    .min(1)
    .max(MAX_MARKDOWN_BODY, { message: MAX_MARKDOWN_BODY_MESSAGE })
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
  pin: pinSchema,
});

const idParam = z.object({ id: z.string().uuid() });

// Opt-in keyset pagination for the list endpoint. Both optional, so a bare
// GET /api/tea-entries keeps returning the full list (nextCursor null). Mirrors
// the loans/trips list contract (SHAN-336/335).
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Cursor is the ISO createdAt of the last row from the previous page. Validate
  // the ISO shape here so a malformed cursor is rejected with 400 rather than
  // silently swallowed downstream (which would resurface page 1). nextCursor is
  // always toISOString() (UTC Z), so valid cursors round-trip unchanged.
  cursor: z.string().datetime().optional(),
});

teaEntriesRoutes.post(
  "/",
  requireAuth,
  requireScope("entries:write"),
  teaEntriesWriteLimit,
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { title, content, pin } = c.req.valid("json");
    const authorTimezone = await getUserTimezone(userId);
    const entry = await createTeaEntry({
      authorId: userId,
      authorTimezone,
      title: title ?? null,
      content,
      pin,
    });
    return c.json(
      {
        entry: {
          id: entry.id,
          authorId: entry.authorId,
          authorTimezone: entry.authorTimezone,
          title: entry.title,
          content: entry.content,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      },
      201,
    );
  },
);

// Opt-in keyset pagination: pass ?limit=N (1..100) and optionally
// ?cursor=<ISO createdAt of the last item from the previous page>. With no
// params the full list is returned and nextCursor is null (legacy behavior).
// When a full page (length === limit) comes back, nextCursor is the createdAt
// of the last row so the caller can fetch the next page.
teaEntriesRoutes.get("/", requireAuth, zValidator("query", listQuery), async (c) => {
  const userId = c.get("userId") as string;
  const { limit, cursor } = c.req.valid("query");
  const entries = await listTeaEntriesForAuthor(userId, { limit, cursor });
  const nextCursor =
    limit && entries.length === limit
      ? entries[entries.length - 1].createdAt.toISOString()
      : null;
  return c.json({ entries, nextCursor });
});

// Per-post auth: the author always gets the full row (content + pin display).
// Non-authors must supply the matching 4-digit PIN in X-Tea-Pin; on success we
// return only the content (never the pin). Anonymous viewers go down the same
// PIN path as a signed-in non-author — knowing the entry id is the gate.
teaEntriesRoutes.get(
  "/:id",
  optionalAuth,
  zValidator("param", idParam),
  async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const row = await getTeaEntryById(id);
    if (!row) return c.json({ error: "Not found" }, 404);

    if (userId && row.authorId === userId) {
      // Author response includes the PIN so the read page can render the
      // asterisks-and-toggle UI. Non-author paths NEVER return the PIN.
      return c.json({
        entry: {
          id: row.id,
          authorId: row.authorId,
          authorTimezone: row.authorTimezone,
          title: row.title,
          content: row.content,
          pin: row.pin,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        isAuthor: true,
      });
    }

    // Per-entry brute-force protection. 4-digit PINs only span 10K keys, so
    // unthrottled attempts crack the gate quickly. Block BEFORE running
    // verifyPin so we don't spend CPU on attackers and so the bucket can't
    // be probed for timing. Author hits short-circuit above this branch and
    // never touch the limiter.
    const blockBefore = isPinAttemptBlocked(row.id);
    if (blockBefore.blocked) {
      return c.json(
        { error: "Too many incorrect PIN attempts. Try again later." },
        429,
        { "Retry-After": String(blockBefore.retryAfterSec) },
      );
    }

    const submittedPin = c.req.header("X-Tea-Pin") ?? "";
    if (!/^\d{4}$/.test(submittedPin)) {
      // 401 carries authorId so the frontend can look up a cached per-author
      // PIN in localStorage and auto-retry without prompting (SHAN-320). The
      // authorId is already public via the teaser feed, so leaking it here
      // adds no new information.
      return c.json({ error: "PIN required", authorId: row.authorId }, 401);
    }
    // Per-entry PIN match is the fast path; only fall back to the author's
    // universal PIN if it's set (SHAN-320). Both compares are constant-time.
    // A universal-PIN match unlocks the entry exactly like a per-entry match
    // — same bucket clear, same response shape.
    let unlocked = verifyPin(submittedPin, row.pin);
    if (!unlocked) {
      const universal = await getUniversalTeaPin(row.authorId);
      if (universal && verifyPin(submittedPin, universal)) {
        unlocked = true;
      }
    }
    if (!unlocked) {
      const after = recordFailedPinAttempt(row.id);
      if (after.blocked) {
        return c.json(
          { error: "Too many incorrect PIN attempts. Try again later." },
          429,
          { "Retry-After": String(after.retryAfterSec) },
        );
      }
      return c.json({ error: "Incorrect PIN" }, 403);
    }
    // Correct PIN clears the bucket so legitimate viewers aren't punished by
    // an attacker who burned attempts on the same entry id.
    clearPinAttempts(row.id);
    return c.json({
      entry: {
        id: row.id,
        authorId: row.authorId,
        authorTimezone: row.authorTimezone,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      isAuthor: false,
    });
  },
);

// Author-only partial update. Body must include at least one field; a no-op
// PATCH is rejected so we never round-trip an empty UPDATE. 404 on author
// mismatch — same response as a missing id, so we don't leak existence.
const patchBody = z
  .object({
    title: z.string().max(255).optional().nullable(),
    content: z
      .string()
      .min(1)
      .max(MAX_MARKDOWN_BODY, { message: MAX_MARKDOWN_BODY_MESSAGE })
      .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE })
      .optional(),
    pin: pinSchema.optional(),
  })
  .refine(
    (b) => b.title !== undefined || b.content !== undefined || b.pin !== undefined,
    { message: "At least one field is required" },
  );

teaEntriesRoutes.patch(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  teaEntriesWriteLimit,
  zValidator("param", idParam),
  zValidator("json", patchBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const row = await updateTeaEntry(id, userId, patch);
    if (!row) return c.json({ error: "Not found or not author" }, 404);
    // Author is the one editing; mirror the GET-author response (PIN included).
    return c.json({
      entry: {
        id: row.id,
        authorId: row.authorId,
        authorTimezone: row.authorTimezone,
        title: row.title,
        content: row.content,
        pin: row.pin,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      isAuthor: true,
    });
  },
);

teaEntriesRoutes.delete(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  teaEntriesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteTeaEntry(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not author" }, 404);
  },
);
