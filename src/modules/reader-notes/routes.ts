import { Hono } from "hono";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { blogPosts, courses, readerNotes, vocabWords } from "@/db/schema";
import { requireAuth, requireBrowserSession } from "@/modules/auth/middleware";
import { anchorSchema, noteMetaSchema } from "@/modules/ai/note-schemas";
import { isSiteOwner } from "@/modules/courses/repo";
import { queueNoteForKnowledge } from "@/modules/knowledge/ingest";
import { uuidId } from "@/modules/shared/validators";
import { zValidator } from "@/modules/shared/zod-validator";

/**
 * SHAN-596: inline notes on blog posts and knowledge cards; courses since
 * SHAN-653 (the course page and the cards inside its lessons).
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

const surfaceEnum = z.enum(["blog", "knowledge", "course"]);

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
  } else if (!body.anchor) {
    return c.json({ error: "A note needs an anchor (the text it is pinned to)" }, 400);
  }

  // SHAN-742: the page must exist and be one the caller can read. Missing and
  // unreadable answer the same 404, so a private course or someone's draft
  // cannot be confirmed to exist through this route either.
  const page = await resolvePage(body.surface, body.resource, userId);
  if (!page) return c.json({ error: "Not found" }, 404);

  if (body.parentId) {
    const [parent] = await db
      .select({ id: readerNotes.id, parentId: readerNotes.parentId, resourceId: readerNotes.resourceId, surface: readerNotes.surface })
      .from(readerNotes)
      .where(and(eq(readerNotes.id, body.parentId), eq(readerNotes.userId, userId)));
    if (!parent || parent.parentId !== null || parent.resourceId !== body.resource || parent.surface !== body.surface) {
      return c.json({ error: "parentId must be one of your notes on this page" }, 400);
    }
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

  if (body.anchor && page.isPublic) {
    queueNoteForKnowledge({ userId, quote: body.anchor.quote, content: body.content, app: body.surface });
  }
  return c.json({ note }, 201);
});

/**
 * The page a note is pinned to, as the caller sees it: null when it is
 * missing or the caller cannot read it, the same rules the blog and course
 * reads apply (a trashed post is gone, a draft is its author's alone, a
 * private course is its creator's and the site owner's).
 *
 * isPublic says whether the note may feed a knowledge card. Knowledge cards
 * are public, so a note only feeds them when the words it quotes are public
 * too: always on a card, only while published on a post (one can be flipped
 * back to draft, SHAN-695), and only on a public course.
 */
async function resolvePage(
  surface: z.infer<typeof surfaceEnum>,
  resourceId: string,
  userId: string,
): Promise<{ isPublic: boolean } | null> {
  if (surface === "knowledge") {
    const [row] = await db.select({ id: vocabWords.id }).from(vocabWords).where(eq(vocabWords.id, resourceId));
    return row ? { isPublic: true } : null;
  }
  if (surface === "blog") {
    const [row] = await db
      .select({ status: blogPosts.status, authorId: blogPosts.authorId })
      .from(blogPosts)
      .where(eq(blogPosts.id, resourceId));
    if (!row || row.status === "trashed") return null;
    if (row.status === "draft" && row.authorId !== userId) return null;
    return { isPublic: row.status === "published" };
  }
  const [row] = await db
    .select({ visibility: courses.visibility, userId: courses.userId })
    .from(courses)
    .where(eq(courses.id, resourceId));
  if (!row) return null;
  if (row.visibility === "public") return { isPublic: true };
  return row.userId === userId || (await isSiteOwner(userId)) ? { isPublic: false } : null;
}

readerNotesRoutes.delete("/:id", zValidator("param", z.object({ id: uuidId("Invalid id") })), async (c) => {
  const userId = c.get("userId") as string;
  const rows = await db
    .delete(readerNotes)
    .where(and(eq(readerNotes.id, c.req.valid("param").id), eq(readerNotes.userId, userId)))
    .returning({ id: readerNotes.id });
  return rows.length ? c.body(null, 204) : c.json({ error: "Note not found" }, 404);
});
