import { Hono } from "hono";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { readerNotes } from "@/db/schema";
import { requireAuth, requireBrowserSession } from "@/modules/auth/middleware";
import { anchorSchema, noteMetaSchema } from "@/modules/ai/note-schemas";
import { queueNoteForKnowledge } from "@/modules/knowledge/ingest";
import { uuidId } from "@/modules/shared/validators";
import { zValidator } from "@/modules/shared/zod-validator";

/**
 * SHAN-596: inline notes on blog posts and knowledge cards.
 *
 * Unlike journal notes (journal_comments, shared with every journal member),
 * these are private to the reader who wrote them: the pages they sit on are
 * public, and a note there is a reading aid, not a reply to the author. So
 * every query is scoped to the caller, and a reply can only go under your own
 * note. Deleting a note deletes its replies (the FK cascades), since they were
 * all yours anyway.
 */
export const readerNotesRoutes = new Hono();

readerNotesRoutes.use("*", requireAuth, requireBrowserSession("Reader notes"));

const surfaceEnum = z.enum(["blog", "knowledge"]);

const listQuery = z.object({ surface: surfaceEnum, resource: uuidId("Invalid resource id") });

readerNotesRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const userId = c.get("userId") as string;
  const { surface, resource } = c.req.valid("query");
  const notes = await db
    .select()
    .from(readerNotes)
    .where(and(eq(readerNotes.userId, userId), eq(readerNotes.surface, surface), eq(readerNotes.resourceId, resource)))
    .orderBy(asc(readerNotes.createdAt));
  return c.json({ notes });
});

const createBody = z
  .object({
    surface: surfaceEnum,
    resource: uuidId("Invalid resource id"),
    content: z.string().trim().min(1).max(10_000),
    anchor: anchorSchema(z.string().trim().min(1).max(80)).optional(),
    parentId: uuidId("Invalid parent id").optional(),
    meta: noteMetaSchema.optional(),
  })
  .strict();

readerNotesRoutes.post("/", zValidator("json", createBody), async (c) => {
  const userId = c.get("userId") as string;
  const body = c.req.valid("json");
  if (body.parentId) {
    if (body.anchor || body.meta) {
      return c.json({ error: "A reply cannot carry an anchor or meta; it belongs to its note's thread" }, 400);
    }
    const [parent] = await db
      .select({ id: readerNotes.id, parentId: readerNotes.parentId, resourceId: readerNotes.resourceId, surface: readerNotes.surface })
      .from(readerNotes)
      .where(and(eq(readerNotes.id, body.parentId), eq(readerNotes.userId, userId)));
    if (!parent || parent.parentId !== null || parent.resourceId !== body.resource || parent.surface !== body.surface) {
      return c.json({ error: "parentId must be one of your notes on this page" }, 400);
    }
  } else if (!body.anchor) {
    return c.json({ error: "A note needs an anchor (the text it is pinned to)" }, 400);
  }

  const [note] = await db
    .insert(readerNotes)
    .values({
      userId,
      surface: body.surface,
      resourceId: body.resource,
      parentId: body.parentId ?? null,
      anchor: body.anchor ?? null,
      meta: body.meta ?? null,
      content: body.content,
    })
    .returning();

  if (body.anchor) {
    queueNoteForKnowledge({ userId, quote: body.anchor.quote, content: body.content, app: body.surface });
  }
  return c.json({ note }, 201);
});

readerNotesRoutes.delete("/:id", zValidator("param", z.object({ id: uuidId("Invalid id") })), async (c) => {
  const userId = c.get("userId") as string;
  const rows = await db
    .delete(readerNotes)
    .where(and(eq(readerNotes.id, c.req.valid("param").id), eq(readerNotes.userId, userId)))
    .returning({ id: readerNotes.id });
  return rows.length ? c.body(null, 204) : c.json({ error: "Note not found" }, 404);
});
