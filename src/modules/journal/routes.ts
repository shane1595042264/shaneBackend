// src/modules/journal/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { listEntries, getEntryByDate, createEntry, softDeleteEntry } from "./entries-repo";
import {
  appendDirectVersion,
  listVersions,
  getVersion,
  revertToVersion,
  VersionConflictError,
} from "./versions-repo";

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
