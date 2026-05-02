// src/modules/journal/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { listEntries, getEntryByDate, createEntry, softDeleteEntry } from "./entries-repo";

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
