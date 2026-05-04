// src/modules/journal/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { listEntries, getEntryByDate, createEntry, softDeleteEntry } from "./entries-repo";
import { eq, and, desc, asc, lt, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries } from "@/db/schema";
import {
  appendDirectVersion,
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
import {
  toggleEntryReaction,
  toggleCommentReaction,
  isAllowedEmoji,
} from "./reactions-repo";

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const journalRoutes = new Hono<Vars>();

const dateParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
});

const listQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const createBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string().min(1),
});

journalRoutes.get("/entries", optionalAuth, zValidator("query", listQuery), async (c) => {
  const q = c.req.valid("query");
  const entries = await listEntries({ from: q.from, to: q.to, limit: q.limit, cursorDate: q.cursor });
  const nextCursor = entries.length === q.limit ? entries[entries.length - 1].date : null;
  return c.json({ entries, nextCursor });
});

journalRoutes.get("/entries/:date", optionalAuth, zValidator("param", dateParam), async (c) => {
  const { date } = c.req.valid("param");
  const row = await getEntryByDate(date);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({
    entry: row.entry,
    content: row.currentVersion?.content ?? "",
    currentVersionNum: row.currentVersion?.versionNum ?? 1,
  });
});

journalRoutes.post(
  "/entries",
  requireAuth,
  requireScope("entries:write"),
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date, content } = c.req.valid("json");
    try {
      const result = await createEntry({ date, authorId: userId, content });
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
  zValidator("param", dateParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await softDeleteEntry(c.req.valid("param").date, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not author" }, 404);
  }
);

const editBody = z.object({ content: z.string().min(1) });
const revertBody = z.object({ target_version_num: z.number().int().positive() });
const versionNumParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  num: z.coerce.number().int().positive(),
});

journalRoutes.patch(
  "/entries/:date",
  requireAuth,
  requireScope("entries:write"),
  zValidator("param", dateParam),
  zValidator("json", editBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { date } = c.req.valid("param");
    const { content } = c.req.valid("json");

    const ifMatch = c.req.header("If-Match");
    if (!ifMatch) return c.json({ error: "If-Match header required" }, 428);
    const ifMatchNum = parseInt(ifMatch, 10);
    if (Number.isNaN(ifMatchNum)) return c.json({ error: "Invalid If-Match" }, 400);

    const row = await getEntryByDate(date);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.entry.authorId !== userId) return c.json({ error: "Only the author can edit directly" }, 403);

    try {
      const v = await appendDirectVersion({
        entryId: row.entry.id,
        editorId: userId,
        content,
        ifMatchVersionNum: ifMatchNum,
      });
      return c.json({ versionNum: v.versionNum, versionId: v.id });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return c.json({ error: "Version conflict", currentVersionNum: err.currentVersionNum }, 409);
      }
      throw err;
    }
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
  proposed_content: z.string().min(1),
});
const rejectBody = z.object({ reason: z.string().optional() });
const suggestionListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
});

journalRoutes.post(
  "/entries/:date/suggestions",
  requireAuth,
  requireScope("suggestions:write"),
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

    const suggestion = await createSuggestion({
      entryId: row.entry.id,
      proposerId: userId,
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

journalRoutes.get("/suggestions/:id", optionalAuth, async (c) => {
  const row = await getSuggestion(c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ suggestion: row });
});

journalRoutes.patch(
  "/suggestions/:id/approve",
  requireAuth,
  requireScope("suggestions:write"),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.param("id");

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
  zValidator("json", rejectBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.param("id");
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
  async (c) => {
    const userId = c.get("userId") as string;
    const id = c.req.param("id");
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
  content: z.string().min(1).max(10_000),
  parent_comment_id: z.string().uuid().optional(),
});
const commentEditBody = z.object({ content: z.string().min(1).max(10_000) });

journalRoutes.get(
  "/entries/:date/comments",
  optionalAuth,
  zValidator("param", dateParam),
  async (c) => {
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const comments = await listCommentsForEntry(row.entry.id);
    return c.json({ comments });
  }
);

journalRoutes.post(
  "/entries/:date/comments",
  requireAuth,
  requireScope("comments:write"),
  zValidator("param", dateParam),
  zValidator("json", commentBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const row = await getEntryByDate(c.req.valid("param").date);
    if (!row) return c.json({ error: "Not found" }, 404);
    const { content, parent_comment_id } = c.req.valid("json");
    const comment = await createComment({
      entryId: row.entry.id,
      authorId: userId,
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
  zValidator("json", commentEditBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const updated = await updateCommentRepo(c.req.param("id"), userId, c.req.valid("json").content);
    if (!updated) return c.json({ error: "Not found or not author" }, 404);
    return c.json({ comment: updated });
  }
);

journalRoutes.delete(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await deleteCommentRepo(c.req.param("id"), userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not authorized" }, 404);
  }
);

const reactionBody = z.object({ emoji: z.string() });

journalRoutes.post(
  "/entries/:date/reactions",
  requireAuth,
  requireScope("reactions:write"),
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
  zValidator("json", reactionBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { emoji } = c.req.valid("json");
    if (!isAllowedEmoji(emoji)) return c.json({ error: "Invalid emoji" }, 400);
    const result = await toggleCommentReaction(userId, c.req.param("id"), emoji);
    return c.json({ result });
  }
);
