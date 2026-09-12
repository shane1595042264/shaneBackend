// src/modules/blog/posts-repo.ts
//
// SHAN-478 Phase 1. The public counterpart to journal/entries-repo.ts.
// Same shape of work, two divergences worth knowing before you edit:
//   - the natural key is a slug, not a date, so every lookup takes a slug
//   - nothing here filters by membership; published rows are world-readable
import { createHash } from "node:crypto";
import { and, desc, eq, lt, or, ilike, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { blogPosts, blogVersions, users } from "@/db/schema";

const EXCERPT_SOURCE_LEN = 500;
// When a search (q) matches deep in the body, start the excerpt this many
// chars earlier so the matched term is visible in the result card.
const SNIPPET_CONTEXT_BEFORE = 60;

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: blogPosts.id })
    .from(blogPosts)
    .where(eq(blogPosts.slug, slug))
    .limit(1);
  return !!row;
}

export async function createPost(input: {
  slug: string;
  title: string;
  authorId: string;
  /** IANA timezone snapshot. Falls back to America/Chicago if omitted (test convenience). */
  authorTimezone?: string;
  content: string;
  tags?: string[];
  status?: "published" | "draft";
  /** Relative /api/journal/images/<id> path, or null for no cover. */
  coverImageUrl?: string | null;
}): Promise<{
  post: typeof blogPosts.$inferSelect;
  version: typeof blogVersions.$inferSelect;
}> {
  return db.transaction(async (tx) => {
    const [post] = await tx
      .insert(blogPosts)
      .values({
        slug: input.slug,
        title: input.title,
        authorId: input.authorId,
        authorTimezone: input.authorTimezone ?? "America/Chicago",
        tags: input.tags ?? [],
        status: input.status ?? "published",
        coverImageUrl: input.coverImageUrl ?? null,
      })
      .returning();

    const [version] = await tx
      .insert(blogVersions)
      .values({
        postId: post.id,
        versionNum: 1,
        title: input.title,
        content: input.content,
        contentHash: hashContent(input.content),
        editorId: input.authorId,
        source: "direct",
      })
      .returning();

    await tx
      .update(blogPosts)
      .set({ currentVersionId: version.id })
      .where(eq(blogPosts.id, post.id));

    return { post: { ...post, currentVersionId: version.id }, version };
  });
}

/**
 * Public read of a single post. `viewerId` only ever widens what is visible:
 * a draft is returned to its own author so the compose/preview flow in Phase 3
 * can reuse this same endpoint. Trashed posts are returned to nobody.
 */
export async function getPostBySlug(slug: string, viewerId?: string | null) {
  const [row] = await db
    .select({
      post: blogPosts,
      currentVersion: blogVersions,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(blogPosts)
    .leftJoin(blogVersions, eq(blogPosts.currentVersionId, blogVersions.id))
    .leftJoin(users, eq(users.id, blogPosts.authorId))
    .where(eq(blogPosts.slug, slug))
    .limit(1);
  if (!row) return null;
  if (row.post.status === "trashed") return null;
  if (row.post.status === "draft" && row.post.authorId !== viewerId) return null;

  const { authorName, authorAvatarUrl, ...rest } = row;
  return {
    ...rest,
    author: { id: rest.post.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  };
}

export async function listPosts(opts: {
  /** Single tag filter, matched against the tags jsonb array. */
  tag?: string;
  /** Case-insensitive search across title and current body. */
  q?: string;
  limit: number;
  /** Keyset cursor: the publishedAt of the last row on the previous page. */
  cursorPublishedAt?: Date;
  /**
   * When set, list this author's drafts alongside their published posts.
   * Callers pass the signed-in user id; anonymous callers pass nothing and
   * only ever see published rows.
   */
  includeDraftsForAuthorId?: string | null;
}) {
  const visible = opts.includeDraftsForAuthorId
    ? or(
        eq(blogPosts.status, "published"),
        and(
          eq(blogPosts.status, "draft"),
          eq(blogPosts.authorId, opts.includeDraftsForAuthorId)
        )
      )!
    : eq(blogPosts.status, "published");

  const where = [visible];
  if (opts.cursorPublishedAt) {
    where.push(lt(blogPosts.publishedAt, opts.cursorPublishedAt));
  }
  if (opts.tag) {
    // Containment against the jsonb array. Parameterized as a one-element
    // array literal so a tag with a quote or brace can't break out.
    where.push(sql`${blogPosts.tags} @> ${JSON.stringify([opts.tag])}::jsonb`);
  }
  if (opts.q) {
    // Escape LIKE wildcards so a literal % or _ is matched as itself.
    const pattern = `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      or(ilike(blogPosts.title, pattern), ilike(blogVersions.content, pattern))!
    );
  }

  // Same excerpt-windowing trick as the journal list: when searching, slide
  // the excerpt back a little so the hit is inside the snippet.
  const excerptStart = opts.q
    ? sql`greatest(1, position(lower(${opts.q}) in lower(${blogVersions.content})) - ${SNIPPET_CONTEXT_BEFORE})`
    : sql`1`;
  const leadingEllipsis = sql`case when ${excerptStart} > 1 then '…' else '' end`;

  const rows = await db
    .select({
      id: blogPosts.id,
      slug: blogPosts.slug,
      title: blogPosts.title,
      authorId: blogPosts.authorId,
      authorTimezone: blogPosts.authorTimezone,
      currentVersionId: blogPosts.currentVersionId,
      status: blogPosts.status,
      coverImageUrl: blogPosts.coverImageUrl,
      tags: blogPosts.tags,
      editCount: blogPosts.editCount,
      publishedAt: blogPosts.publishedAt,
      createdAt: blogPosts.createdAt,
      updatedAt: blogPosts.updatedAt,
      contentExcerpt: sql<string | null>`${leadingEllipsis} || substring(${blogVersions.content} from ${excerptStart} for ${EXCERPT_SOURCE_LEN})`,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(blogPosts)
    .leftJoin(blogVersions, eq(blogPosts.currentVersionId, blogVersions.id))
    .leftJoin(users, eq(users.id, blogPosts.authorId))
    .where(and(...where))
    .orderBy(desc(blogPosts.publishedAt))
    .limit(opts.limit);

  return rows.map(({ authorName, authorAvatarUrl, ...rest }) => ({
    ...rest,
    author: { id: rest.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  }));
}

/**
 * Metadata-only update. Title and body changes do NOT come through here —
 * those mint a new version via versions-repo.appendDirectVersion, because
 * they belong in the revision history. This handles tags and the
 * draft/published flip, plus the cover image, none of which do.
 */
export async function updatePostMeta(
  slug: string,
  authorId: string,
  patch: {
    tags?: string[];
    status?: "published" | "draft";
    /** Explicit null clears the cover; undefined leaves it untouched. */
    coverImageUrl?: string | null;
  }
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.coverImageUrl !== undefined) set.coverImageUrl = patch.coverImageUrl;
  if (patch.status !== undefined) {
    set.status = patch.status;
    // Publishing should date the post from now, not from whenever the draft
    // was started, otherwise it lands mid-list already buried. Guarded in SQL
    // against the OLD status so re-PATCHing an already-published post with
    // status:"published" (which the tag editor does on every save) does not
    // keep bumping it back to the top of the index.
    if (patch.status === "published") {
      set.publishedAt = sql`case when ${blogPosts.status} = 'draft' then now() else ${blogPosts.publishedAt} end`;
    }
  }
  const [row] = await db
    .update(blogPosts)
    .set(set)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.authorId, authorId)))
    .returning();
  return row ?? null;
}

export async function softDeletePost(slug: string, authorId: string): Promise<boolean> {
  const result = await db
    .update(blogPosts)
    .set({ status: "trashed", updatedAt: new Date() })
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.authorId, authorId)))
    .returning({ id: blogPosts.id });
  return result.length > 0;
}
