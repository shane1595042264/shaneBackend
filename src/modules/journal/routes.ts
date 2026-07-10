// src/modules/journal/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { getUserTimezone } from "@/modules/auth/user-prefs";
import { listEntries, getEntryByDate, createEntry, softDeleteEntry } from "./entries-repo";
import { createAppend, listAppendsForEntry } from "./appends-repo";
import { eq, and, desc, asc, lt, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries } from "@/db/schema";
import {
  listVersions,
  getVersion,
  revertToVersion,
  VersionConflictError,
} from "./versions-repo";
import {
  createSuggestion,
  getSuggestion,
  listSuggestionsForEntry,
  approveSuggestion,
  rejectSuggestion,
  withdrawSuggestion,
  inboxFor,
} from "./suggestions-repo";
import {
  createComment,
  listForEntry as listCommentsForEntry,
  updateComment as updateCommentRepo,
  deleteComment as deleteCommentRepo,
  getComment,
} from "./comments-repo";
import { insertImage, getImageById, countUploadsInWindow } from "./images-repo";
import { sniffImageMime } from "@/modules/shared/image-validate";
import {
  toggleEntryReaction,
  toggleCommentReaction,
  isAllowedEmoji,
  summarizeEntryReactions,
  listMyReactionsForEntry,
  summarizeCommentReactions,
  listMyReactionsForComment,
} from "./reactions-repo";
import {
  isoDate,
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_MESSAGE,
} from "@/modules/shared/validators";
import { createPATRateLimit } from "@/modules/shared/rate-limit";

const noInFlightUpload = (v: string) => !containsInFlightUpload(v);

// Per-PAT rolling-60s rate limits on the journal write surface. JWTs bypass
// (tokenId is null for browser sessions). Buckets are per-scope so a busy
// commenter doesn't lock out their own reactions, etc.
const entriesWriteLimit = createPATRateLimit({
  bucket: "journal-entries-write",
  limitPerMinute: 30,
});
const suggestionsWriteLimit = createPATRateLimit({
  bucket: "journal-suggestions-write",
  limitPerMinute: 30,
});
const commentsWriteLimit = createPATRateLimit({
  bucket: "journal-comments-write",
  limitPerMinute: 30,
});
const reactionsWriteLimit = createPATRateLimit({
  bucket: "journal-reactions-write",
  limitPerMinute: 60,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const journalRoutes = new Hono<Vars>();

const dateParam = z.object({ date: isoDate });
// Guards the :id path param on suggestion/comment routes. Without this a
// malformed id reaches the Postgres uuid column and throws "invalid input
// syntax for type uuid", surfacing as a misleading 500 instead of a 400.
const uuidParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // SHAN-373: validate as an ISO date, not z.string().datetime(). The journal
  // cursor is the entry `date` (YYYY-MM-DD) that nextCursor emits below — unlike
  // trips/loans/tea-entries (SHAN-372), which paginate by a createdAt timestamp.
  // Without this, a malformed cursor reaches `lt(journalEntries.date, ...)` and
  // Postgres throws "invalid input syntax for type date" → a misleading 500.
  cursor: isoDate.optional(),
});

const createBody = z.object({
  date: isoDate,
  content: z
    .string()
    .min(1)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
});

journalRoutes.get("/entries", optionalAuth, zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  const entries = await listEntries({
    from: query.from,
    to: query.to,
    q: query.q,
    limit: query.limit,
    cursorDate: query.cursor,
  });
  const nextCursor = entries.length === query.limit ? entries[entries.length - 1].date : null;
  return c.json({ entries, nextCursor });
});

journalRoutes.get("/entries/:date", optionalAuth, zValidator("param", dateParam), async (c) => {
  const { date } = c.req.valid("param");
  const row = await getEntryByDate(date);
  if (!row) return c.json({ error: "Not found" }, 404);
  const appends = await listAppendsForEntry(row.entry.id);
  return c.json({
    entry: row.entry,
    author: row.author,
    content: row.currentVersion?.content ?? "",
    currentVersionNum: row.currentVersion?.versionNum ?? 1,
    appends,
  });
});

journalRoutes.post(
  "/entries",
  requireAuth,
  requireScope("entries:write"),
  entriesWriteLimit,
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date, content } = c.req.valid("json");
    try {
      const authorTimezone = await getUserTimezone(userId);
      const result = await createEntry({ date, authorId: userId, authorTimezone, content });
      return c.json({ entry: result.entry, currentVersionNum: 1 }, 201);
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") {
        return c.json({ error: "Entry for this date already exists" }, 409);
      }
      throw err;
    }
  }
);

journalRoutes.delete(
  "/entries/:date",
  requireAuth,
  requireScope("entries:write"),
  entriesWriteLimit,
  zValidator("param", dateParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await softDeleteEntry(c.req.valid("param").date, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not author" }, 404);
  }
);

const revertBody = z.object({ target_version_num: z.number().int().positive() });
const versionNumParam = z.object({
  date: isoDate,
  num: z.coerce.number().int().positive(),
});

journalRoutes.patch("/entries/:date", zValidator("param", dateParam), async (c) =>
  c.json(
    { error: "Entries are append-only; use POST /api/journal/entries/:date/appends" },
    405
  )
);

const appendBody = z.object({
  content: z
    .string()
    .min(1)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
});

journalRoutes.post(
  "/entries/:date/appends",
  requireAuth,
  requireScope("entries:write"),
  entriesWriteLimit,
  zValidator("param", dateParam),
  zValidator("json", appendBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date } = c.req.valid("param");
    const { content } = c.req.valid("json");

    const row = await getEntryByDate(date);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.entry.authorId !== userId) {
      return c.json({ error: "Only the author can append" }, 403);
    }

    const authorTimezone = await getUserTimezone(userId);
    const append = await createAppend({
      entryId: row.entry.id,
      authorId: userId,
      authorTimezone,
      content,
    });
    return c.json({ append }, 201);
  }
);

journalRoutes.get(
  "/entries/:date/appends",
  optionalAuth,
  zValidator("param", dateParam),
  async (c) => {
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const appends = await listAppendsForEntry(row.entry.id);
    return c.json({ appends });
  }
);

journalRoutes.get("/entries/:date/versions", optionalAuth, zValidator("param", dateParam), async (c) => {
  const row = await getEntryByDate(c.req.valid("param").date);
  if (!row) return c.json({ error: "Not found" }, 404);
  const versions = await listVersions(row.entry.id);
  return c.json({ versions });
});

journalRoutes.get(
  "/entries/:date/versions/:num",
  optionalAuth,
  zValidator("param", versionNumParam),
  async (c) => {
    const { date, num } = c.req.valid("param");
    const row = await getEntryByDate(date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const version = await getVersion(row.entry.id, num);
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json({ version });
  }
);

journalRoutes.post(
  "/entries/:date/revert",
  requireAuth,
  requireScope("entries:write"),
  entriesWriteLimit,
  zValidator("param", dateParam),
  zValidator("json", revertBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date } = c.req.valid("param");
    const { target_version_num } = c.req.valid("json");

    const ifMatch = c.req.header("If-Match");
    if (!ifMatch) return c.json({ error: "If-Match header required" }, 428);
    const ifMatchNum = parseInt(ifMatch, 10);

    const row = await getEntryByDate(date);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.entry.authorId !== userId) return c.json({ error: "Only the author can revert" }, 403);

    try {
      const v = await revertToVersion(row.entry.id, target_version_num, userId, ifMatchNum);
      return c.json({ versionNum: v.versionNum, versionId: v.id });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return c.json({ error: "Version conflict", currentVersionNum: err.currentVersionNum }, 409);
      }
      throw err;
    }
  }
);

journalRoutes.get(
  "/entries/:date/neighbors",
  optionalAuth,
  zValidator("param", dateParam),
  async (c) => {
    const { date } = c.req.valid("param");
    const [prevRow] = await db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(lt(journalEntries.date, date), eq(journalEntries.status, "published")))
      .orderBy(desc(journalEntries.date))
      .limit(1);
    const [nextRow] = await db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(gt(journalEntries.date, date), eq(journalEntries.status, "published")))
      .orderBy(asc(journalEntries.date))
      .limit(1);
    return c.json({ prev: prevRow?.date ?? null, next: nextRow?.date ?? null });
  }
);

const suggestBody = z.object({
  base_version_num: z.number().int().positive(),
  proposed_content: z
    .string()
    .min(1)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
});
const rejectBody = z.object({ reason: z.string().optional() });
const suggestionListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
});

journalRoutes.post(
  "/entries/:date/suggestions",
  requireAuth,
  requireScope("suggestions:write"),
  suggestionsWriteLimit,
  zValidator("param", dateParam),
  zValidator("json", suggestBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date } = c.req.valid("param");
    const { base_version_num, proposed_content } = c.req.valid("json");

    const row = await getEntryByDate(date);
    if (!row) return c.json({ error: "Entry not found" }, 404);
    if (row.entry.authorId === userId) return c.json({ error: "Authors edit directly, not via suggestions" }, 403);

    const baseVersion = await getVersion(row.entry.id, base_version_num);
    if (!baseVersion) return c.json({ error: "Base version not found" }, 404);

    const authorTimezone = await getUserTimezone(userId);
    const suggestion = await createSuggestion({
      entryId: row.entry.id,
      proposerId: userId,
      authorTimezone,
      baseVersionId: baseVersion.id,
      proposedContent: proposed_content,
    });
    return c.json({ suggestion }, 201);
  }
);

journalRoutes.get(
  "/entries/:date/suggestions",
  optionalAuth,
  zValidator("param", dateParam),
  zValidator("query", suggestionListQuery),
  async (c) => {
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const list = await listSuggestionsForEntry(row.entry.id, c.req.valid("query").status);
    return c.json({ suggestions: list });
  }
);

journalRoutes.get("/suggestions/:id", optionalAuth, zValidator("param", uuidParam), async (c) => {
  const row = await getSuggestion(c.req.valid("param").id);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ suggestion: row });
});

journalRoutes.patch(
  "/suggestions/:id/approve",
  requireAuth,
  requireScope("suggestions:write"),
  suggestionsWriteLimit,
  zValidator("param", uuidParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.valid("param").id;

    const s = await getSuggestion(id);
    if (!s) return c.json({ error: "Not found" }, 404);

    const ifMatch = c.req.header("If-Match");
    if (!ifMatch) return c.json({ error: "If-Match header required" }, 428);
    const ifMatchNum = parseInt(ifMatch, 10);
    if (Number.isNaN(ifMatchNum)) return c.json({ error: "Invalid If-Match" }, 400);

    // Verify caller is the author of the parent entry
    const [entryRow] = await db
      .select({ authorId: journalEntries.authorId })
      .from(journalEntries)
      .where(eq(journalEntries.id, s.entryId))
      .limit(1);
    if (!entryRow || entryRow.authorId !== userId) return c.json({ error: "Only the entry author can approve" }, 403);

    try {
      const v = await approveSuggestion(id, userId, ifMatchNum);
      return c.json({ versionNum: v.versionNum, versionId: v.id });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return c.json({ error: "Version conflict", currentVersionNum: err.currentVersionNum }, 409);
      }
      throw err;
    }
  }
);

journalRoutes.patch(
  "/suggestions/:id/reject",
  requireAuth,
  requireScope("suggestions:write"),
  suggestionsWriteLimit,
  zValidator("param", uuidParam),
  zValidator("json", rejectBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.valid("param").id;
    const s = await getSuggestion(id);
    if (!s) return c.json({ error: "Not found" }, 404);

    const [entryRow] = await db
      .select({ authorId: journalEntries.authorId })
      .from(journalEntries)
      .where(eq(journalEntries.id, s.entryId))
      .limit(1);
    if (!entryRow || entryRow.authorId !== userId) return c.json({ error: "Only the entry author can reject" }, 403);

    const updated = await rejectSuggestion(id, userId, c.req.valid("json").reason);
    return c.json({ suggestion: { ...updated, status: "rejected" } });
  }
);

journalRoutes.patch(
  "/suggestions/:id/withdraw",
  requireAuth,
  requireScope("suggestions:write"),
  suggestionsWriteLimit,
  zValidator("param", uuidParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.valid("param").id;
    try {
      const updated = await withdrawSuggestion(id, userId);
      return c.json({ suggestion: { ...updated, status: "withdrawn" } });
    } catch {
      return c.json({ error: "Cannot withdraw" }, 403);
    }
  }
);

journalRoutes.get("/inbox", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const items = await inboxFor(userId);
  return c.json({ items });
});

const commentBody = z.object({
  content: z
    .string()
    .min(1)
    .max(10_000)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
  parent_comment_id: z.string().uuid().optional(),
});
const commentEditBody = z.object({
  content: z
    .string()
    .min(1)
    .max(10_000)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
});

journalRoutes.get(
  "/entries/:date/comments",
  optionalAuth,
  zValidator("param", dateParam),
  async (c) => {
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const comments = await listCommentsForEntry(row.entry.id, c.get("userId"));
    return c.json({ comments });
  }
);

journalRoutes.post(
  "/entries/:date/comments",
  requireAuth,
  requireScope("comments:write"),
  commentsWriteLimit,
  zValidator("param", dateParam),
  zValidator("json", commentBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const { content, parent_comment_id } = c.req.valid("json");
    const authorTimezone = await getUserTimezone(userId);
    const comment = await createComment({
      entryId: row.entry.id,
      authorId: userId,
      authorTimezone,
      content,
      parentCommentId: parent_comment_id,
    });
    return c.json({ comment }, 201);
  }
);

journalRoutes.patch(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  commentsWriteLimit,
  zValidator("param", uuidParam),
  zValidator("json", commentEditBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const updated = await updateCommentRepo(c.req.valid("param").id, userId, c.req.valid("json").content);
    if (!updated) return c.json({ error: "Not found or not author" }, 404);
    return c.json({ comment: updated });
  }
);

journalRoutes.delete(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  commentsWriteLimit,
  zValidator("param", uuidParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await deleteCommentRepo(c.req.valid("param").id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not authorized" }, 404);
  }
);

const reactionBody = z.object({ emoji: z.string() });

journalRoutes.post(
  "/entries/:date/reactions",
  requireAuth,
  requireScope("reactions:write"),
  reactionsWriteLimit,
  zValidator("param", dateParam),
  zValidator("json", reactionBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { emoji } = c.req.valid("json");
    if (!isAllowedEmoji(emoji)) return c.json({ error: "Invalid emoji" }, 400);
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const result = await toggleEntryReaction(userId, row.entry.id, emoji);
    return c.json({ result });
  }
);

journalRoutes.post(
  "/comments/:id/reactions",
  requireAuth,
  requireScope("reactions:write"),
  reactionsWriteLimit,
  zValidator("param", uuidParam),
  zValidator("json", reactionBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { emoji } = c.req.valid("json");
    if (!isAllowedEmoji(emoji)) return c.json({ error: "Invalid emoji" }, 400);
    const commentId = c.req.valid("param").id;
    const comment = await getComment(commentId);
    if (!comment) return c.json({ error: "Not found" }, 404);
    const result = await toggleCommentReaction(userId, commentId, emoji);
    return c.json({ result });
  }
);

journalRoutes.get(
  "/entries/:date/reactions",
  optionalAuth,
  zValidator("param", dateParam),
  async (c) => {
    const userId = c.get("userId") as string | null;
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const summary = await summarizeEntryReactions(row.entry.id);
    const mine = userId ? (await listMyReactionsForEntry(row.entry.id, userId)).map((r) => r.emoji) : [];
    return c.json({ summary, mine });
  }
);

journalRoutes.get("/comments/:id/reactions", optionalAuth, zValidator("param", uuidParam), async (c) => {
  const userId = c.get("userId") as string | null;
  const commentId = c.req.valid("param").id;
  const comment = await getComment(commentId);
  if (!comment) return c.json({ error: "Not found" }, 404);
  const summary = await summarizeCommentReactions(commentId);
  const mine = userId ? (await listMyReactionsForComment(commentId, userId)).map((r) => r.emoji) : [];
  return c.json({ summary, mine });
});

// ---------------------------------------------------------------------------
// Inline images for the markdown editor (paste-to-upload).
//
// POST /api/journal/images — multipart/form-data, field `file`, 5MB cap.
//   The canonical MIME is derived from server-side magic-byte sniffing, not
//   from the client-supplied Content-Type, because (a) startsWith("image/")
//   accepted image/svg+xml which is an XSS vector when the URL is opened
//   directly, and (b) any client can spoof file.type. Allowlist:
//   png/jpeg/gif/webp.
// GET /api/journal/images/:id — streams the raw bytes with the stored mime
//   type. Immutable cache because the URL is content-addressed by uuid.
//   X-Content-Type-Options: nosniff prevents browsers from disagreeing with
//   the stored type if it ever drifts.
// ---------------------------------------------------------------------------
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_DAILY_LIMIT = 100;
const IMAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

journalRoutes.post("/images", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data with a 'file' field" }, 400);
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing 'file' in multipart upload" }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: "Empty file" }, 400);
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return c.json({ error: "Image too large (max 5MB)" }, 413);
  }
  const now = new Date();
  const windowStart = new Date(now.getTime() - IMAGE_WINDOW_MS);
  const { count, oldestCreatedAt } = await countUploadsInWindow(userId, windowStart);
  if (count >= IMAGE_DAILY_LIMIT) {
    // Honest Retry-After: when the oldest row exits the trailing window, the
    // count drops by one and the next upload succeeds. Min 1s so we never
    // emit Retry-After: 0 (which some clients treat as "retry immediately").
    const expiresAtMs = oldestCreatedAt
      ? new Date(oldestCreatedAt).getTime() + IMAGE_WINDOW_MS
      : now.getTime() + IMAGE_WINDOW_MS;
    const retryAfter = Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000));
    return c.json(
      { error: `Upload quota exceeded (${IMAGE_DAILY_LIMIT}/24h). Try again later.` },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffedMime = sniffImageMime(buffer);
  if (!sniffedMime) {
    return c.json({ error: "Unsupported image type — png/jpeg/gif/webp only" }, 415);
  }
  const { id } = await insertImage({ uploadedBy: userId, mimeType: sniffedMime, data: buffer });
  return c.json({ id, url: `/api/journal/images/${id}` }, 201);
});

journalRoutes.get("/images/:id", zValidator("param", uuidParam), async (c) => {
  const { id } = c.req.valid("param");
  const row = await getImageById(id);
  if (!row) return c.json({ error: "Not found" }, 404);
  return new Response(new Uint8Array(row.data), {
    status: 200,
    headers: {
      "Content-Type": row.mimeType,
      "Content-Length": String(row.byteSize),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});
