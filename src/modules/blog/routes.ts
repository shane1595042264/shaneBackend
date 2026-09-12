// src/modules/blog/routes.ts
//
// SHAN-478 Phase 1. The public blog. Structurally this is journal/routes.ts
// with the membership gate removed and the date key swapped for a slug.
//
// Read that sentence again before adding a route here: there is deliberately
// no requireJournalMembership (SHAN-475) anywhere in this file. Every GET is
// answerable by an anonymous caller. Writes are author-only, enforced per
// route by comparing post.authorId to the resolved userId.
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@/modules/shared/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { getUserTimezone } from "@/modules/auth/user-prefs";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { generateUniqueSlug } from "@/modules/trips/slug";
import {
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_MESSAGE,
  MAX_MARKDOWN_BODY,
  MAX_MARKDOWN_BODY_MESSAGE,
  trimmedRequired,
  trimmedLabels,
} from "@/modules/shared/validators";
import {
  createPost,
  getPostBySlug,
  listPosts,
  slugTaken,
  softDeletePost,
  updatePostMeta,
} from "./posts-repo";
import {
  appendDirectVersion,
  getVersion,
  listVersions,
  revertToVersion,
  VersionConflictError,
} from "./versions-repo";

const noInFlightUpload = (v: string) => !containsInFlightUpload(v);

// Per-PAT rolling-60s write limit. JWT browser sessions bypass (tokenId is
// null for them). Own bucket so blog writes don't share a budget with the
// journal.
const blogWriteLimit = createPATRateLimit({
  bucket: "blog-write",
  limitPerMinute: 30,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const blogRoutes = new Hono<Vars>();

const MAX_TITLE = 200;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 40;
const MAX_COVER_URL = 500;

// A cover is either the shared uploader's own output
// (/api/journal/images/<uuid>, stored relative so it survives an origin move)
// or an absolute https URL for art hosted elsewhere. Everything else is
// rejected: an arbitrary same-origin path would let a cover point at any
// backend route, and http:/data:/javascript: are not image sources we serve.
const COVER_URL_RE =
  /^(?:\/api\/journal\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|https:\/\/[^\s<>"']+)$/i;

// Nullish rather than optional: an explicit null is how a client removes a
// cover, while omitting the field leaves the existing one alone. Blank strings
// collapse to null so an emptied input doesn't persist as "".
const coverImageUrl = z
  .string()
  .max(MAX_COVER_URL)
  .nullish()
  .transform((v) => {
    if (v === undefined || v === null) return v;
    const t = v.trim();
    return t.length ? t : null;
  })
  .refine((v) => v == null || COVER_URL_RE.test(v), {
    message: "cover_image_url must be an uploaded image path or an https URL",
  });

const slugParam = z.object({
  // Matches what generateUniqueSlug can emit. Rejecting junk here keeps a
  // malformed slug from reaching the varchar(80) column as a pointless query.
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Invalid slug" }),
});

const versionNumParam = slugParam.extend({
  num: z.coerce.number().int().positive(),
});

const bodyContent = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MARKDOWN_BODY, { message: MAX_MARKDOWN_BODY_MESSAGE })
  .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE });

const listQuery = z.object({
  tag: z.string().trim().min(1).max(MAX_TAG_LEN).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Keyset cursor on published_at. Unlike the journal (whose cursor is an
  // isoDate, SHAN-373), blog posts are ordered by a timestamp, so this really
  // is a datetime. Validated here so a malformed value 400s instead of
  // reaching Postgres and throwing "invalid input syntax for type timestamp".
  cursor: z.string().datetime().optional(),
});

const createBody = z.object({
  title: trimmedRequired(MAX_TITLE),
  content: bodyContent,
  tags: trimmedLabels(MAX_TAG_LEN, MAX_TAGS).optional(),
  status: z.enum(["published", "draft"]).default("published"),
  cover_image_url: coverImageUrl,
});

// Every field optional: a PATCH may carry only tags, only a status flip, only
// a new body, or any combination. An empty object is rejected below rather
// than silently minting an identical version.
const updateBody = z.object({
  title: trimmedRequired(MAX_TITLE).optional(),
  content: bodyContent.optional(),
  tags: trimmedLabels(MAX_TAG_LEN, MAX_TAGS).optional(),
  status: z.enum(["published", "draft"]).optional(),
  cover_image_url: coverImageUrl,
});

const versionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().min(1).optional(),
});

const revertBody = z.object({ target_version_num: z.number().int().positive() });

/**
 * Read the optimistic-concurrency version, preferring the plain `If-Match`
 * header and falling back to `X-If-Match`.
 *
 * Why the alias exists (SHAN-487): browser writes are same-origin and ride the
 * Vercel rewrite (SHAN-458). Vercel's proxy evaluates a real `If-Match` against
 * the response ETag, and every 200 JSON response here carries a WEAK one
 * (conditionalGet in app.ts) — a weak validator can never satisfy If-Match,
 * which requires strong comparison. The result was the worst possible failure
 * mode: the PATCH reached the backend and committed, then Vercel replaced the
 * 200 with `412 PRECONDITION_FAILED`, so the editor reported "failed to save"
 * on a write that had already landed and a retry wrote it twice. Error
 * responses (409/428) carry no ETag, which is why only the successes broke.
 *
 * `If-Match` stays the documented header for direct callers (PAT + curl
 * straight at Railway); browsers send `X-If-Match`, which no proxy interprets.
 */
function readIfMatch(c: { req: { header(name: string): string | undefined } }) {
  return c.req.header("If-Match") ?? c.req.header("X-If-Match");
}

// ── Public reads ───────────────────────────────────────────────────

blogRoutes.get("/posts", optionalAuth, zValidator("query", listQuery), async (c) => {
  const query = c.req.valid("query");
  const viewerId = c.get("userId");
  const posts = await listPosts({
    tag: query.tag,
    q: query.q,
    limit: query.limit,
    cursorPublishedAt: query.cursor ? new Date(query.cursor) : undefined,
    includeDraftsForAuthorId: viewerId,
  });
  const nextCursor =
    posts.length === query.limit
      ? posts[posts.length - 1].publishedAt.toISOString()
      : null;
  return c.json({ posts, nextCursor });
});

blogRoutes.get("/posts/:slug", optionalAuth, zValidator("param", slugParam), async (c) => {
  const { slug } = c.req.valid("param");
  const row = await getPostBySlug(slug, c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({
    post: row.post,
    author: row.author,
    title: row.currentVersion?.title ?? row.post.title,
    content: row.currentVersion?.content ?? "",
    currentVersionNum: row.currentVersion?.versionNum ?? 1,
  });
});

blogRoutes.get(
  "/posts/:slug/versions",
  optionalAuth,
  zValidator("param", slugParam),
  zValidator("query", versionsQuery),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const row = await getPostBySlug(slug, c.get("userId"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const versions = await listVersions(row.post.id, { limit, cursor });
    const nextCursor =
      versions.length === limit ? versions[versions.length - 1].versionNum : null;
    return c.json({ versions, nextCursor });
  }
);

blogRoutes.get(
  "/posts/:slug/versions/:num",
  optionalAuth,
  zValidator("param", versionNumParam),
  async (c) => {
    const { slug, num } = c.req.valid("param");
    const row = await getPostBySlug(slug, c.get("userId"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const version = await getVersion(row.post.id, num);
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json({ version });
  }
);

// ── Author-only writes ─────────────────────────────────────────────

blogRoutes.post(
  "/posts",
  requireAuth,
  requireScope("entries:write"),
  blogWriteLimit,
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { title, content, tags, status, cover_image_url } = c.req.valid("json");
    const authorTimezone = await getUserTimezone(userId);

    // generateUniqueSlug probes for a free slug and then we insert, which is
    // check-then-act: two posts created with the same title in the same
    // instant both see "my-post" as free and the second insert trips the
    // unique constraint. Retry once with a fresh slug (the second probe sees
    // the now-committed row and adds a suffix) rather than 500ing.
    for (let attempt = 0; ; attempt++) {
      const slug = await generateUniqueSlug(title, slugTaken);
      try {
        const result = await createPost({
          slug,
          title,
          authorId: userId,
          authorTimezone,
          content,
          tags,
          status,
          coverImageUrl: cover_image_url ?? null,
        });
        return c.json({ post: result.post, currentVersionNum: 1 }, 201);
      } catch (err: any) {
        const isSlugClash = err?.code === "23505" || err?.cause?.code === "23505";
        if (!isSlugClash || attempt >= 1) throw err;
      }
    }
  }
);

blogRoutes.patch(
  "/posts/:slug",
  requireAuth,
  requireScope("entries:write"),
  blogWriteLimit,
  zValidator("param", slugParam),
  zValidator("json", updateBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { slug } = c.req.valid("param");
    const patch = c.req.valid("json");

    if (
      patch.title === undefined &&
      patch.content === undefined &&
      patch.tags === undefined &&
      patch.status === undefined &&
      patch.cover_image_url === undefined
    ) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const row = await getPostBySlug(slug, userId);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.post.authorId !== userId) {
      return c.json({ error: "Only the author can edit" }, 403);
    }

    // Title/body edits go into the revision history; tags, the cover and the
    // draft/published flip are plain metadata and do not.
    const touchesBody = patch.title !== undefined || patch.content !== undefined;
    let currentVersionNum = row.currentVersion?.versionNum ?? 1;

    if (touchesBody) {
      const ifMatch = readIfMatch(c);
      if (!ifMatch) return c.json({ error: "If-Match header required" }, 428);
      const ifMatchNum = parseInt(ifMatch, 10);
      if (Number.isNaN(ifMatchNum)) return c.json({ error: "Invalid If-Match" }, 400);

      try {
        const version = await appendDirectVersion({
          postId: row.post.id,
          editorId: userId,
          title: patch.title ?? row.currentVersion?.title ?? row.post.title,
          content: patch.content ?? row.currentVersion?.content ?? "",
          ifMatchVersionNum: ifMatchNum,
        });
        currentVersionNum = version.versionNum;
      } catch (err) {
        if (err instanceof VersionConflictError) {
          return c.json(
            { error: "Version conflict", currentVersionNum: err.currentVersionNum },
            409
          );
        }
        throw err;
      }
    }

    let post = row.post;
    if (
      patch.tags !== undefined ||
      patch.status !== undefined ||
      patch.cover_image_url !== undefined
    ) {
      // Runs after the version append, so its RETURNING row already carries
      // the new title and editCount.
      const updated = await updatePostMeta(slug, userId, {
        tags: patch.tags,
        status: patch.status,
        coverImageUrl: patch.cover_image_url,
      });
      if (updated) post = updated;
    } else if (touchesBody) {
      // Body-only edit: `row` was read before appendDirectVersion bumped the
      // denormalized title and editCount, so returning it verbatim hands the
      // client a pre-edit snapshot and the edit UI renders the old title until
      // it happens to refetch. Re-read instead.
      const fresh = await getPostBySlug(slug, userId);
      if (fresh) post = fresh.post;
    }

    return c.json({ post, currentVersionNum });
  }
);

blogRoutes.post(
  "/posts/:slug/revert",
  requireAuth,
  requireScope("entries:write"),
  blogWriteLimit,
  zValidator("param", slugParam),
  zValidator("json", revertBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { slug } = c.req.valid("param");
    const { target_version_num } = c.req.valid("json");

    const ifMatch = readIfMatch(c);
    if (!ifMatch) return c.json({ error: "If-Match header required" }, 428);
    const ifMatchNum = parseInt(ifMatch, 10);
    if (Number.isNaN(ifMatchNum)) return c.json({ error: "Invalid If-Match" }, 400);

    const row = await getPostBySlug(slug, userId);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.post.authorId !== userId) {
      return c.json({ error: "Only the author can revert" }, 403);
    }

    try {
      const v = await revertToVersion(row.post.id, target_version_num, userId, ifMatchNum);
      return c.json({ versionNum: v.versionNum, versionId: v.id });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return c.json(
          { error: "Version conflict", currentVersionNum: err.currentVersionNum },
          409
        );
      }
      if (err instanceof Error && err.message === "Target version not found") {
        return c.json({ error: "Target version not found" }, 404);
      }
      throw err;
    }
  }
);

blogRoutes.delete(
  "/posts/:slug",
  requireAuth,
  requireScope("entries:write"),
  blogWriteLimit,
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const ok = await softDeletePost(c.req.valid("param").slug, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not author" }, 404);
  }
);
