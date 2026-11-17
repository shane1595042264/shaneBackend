// src/modules/blog/reading-repo.ts
//
// SHAN-705: where each signed-in reader left off in each blog post, so the
// blog resumes the way the journal does (SHAN-597). One row per (reader,
// post), overwritten on every save. Same anchor as the journal's; see
// modules/shared/reading-position.ts.
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { blogPosts, blogReadingPositions } from "@/db/schema";
import type { ReadingAnchor } from "@/modules/shared/reading-position";

export interface BlogReadingPosition {
  slug: string;
  title: string;
  progress: number;
  anchor: ReadingAnchor;
  updatedAt: Date;
}

/**
 * The published post for a slug, or null. Only published posts are read by
 * anyone but their author, and a draft has nothing to come back to yet.
 */
export async function postForSlug(slug: string): Promise<{ id: string; title: string } | null> {
  const [row] = await db
    .select({ id: blogPosts.id, title: blogPosts.title })
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.status, "published")))
    .limit(1);
  return row ?? null;
}

// Selected inside each function: a module-level `table.col` throws under the
// partial @/db/schema mocks the route tests use.
function columns() {
  return {
    slug: blogPosts.slug,
    title: blogPosts.title,
    progress: blogReadingPositions.progress,
    anchor: blogReadingPositions.anchor,
    updatedAt: blogReadingPositions.updatedAt,
  };
}

export async function getBlogReadingPosition(userId: string, slug: string): Promise<BlogReadingPosition | null> {
  const [row] = await db
    .select(columns())
    .from(blogReadingPositions)
    .innerJoin(blogPosts, eq(blogPosts.id, blogReadingPositions.postId))
    .where(
      and(eq(blogReadingPositions.userId, userId), eq(blogPosts.slug, slug), eq(blogPosts.status, "published"))
    )
    .limit(1);
  return (row as BlogReadingPosition | undefined) ?? null;
}

/** Most recently read first; posts no longer published are left out. */
export async function listBlogReadingPositions(userId: string, limit: number): Promise<BlogReadingPosition[]> {
  const rows = await db
    .select(columns())
    .from(blogReadingPositions)
    .innerJoin(blogPosts, eq(blogPosts.id, blogReadingPositions.postId))
    .where(and(eq(blogReadingPositions.userId, userId), eq(blogPosts.status, "published")))
    .orderBy(desc(blogReadingPositions.updatedAt))
    .limit(limit);
  return rows as BlogReadingPosition[];
}

/** Last write wins, by server time, as on the journal. */
export async function saveBlogReadingPosition(input: {
  userId: string;
  post: { id: string; title: string };
  slug: string;
  progress: number;
  anchor: ReadingAnchor;
}): Promise<BlogReadingPosition> {
  const [row] = await db
    .insert(blogReadingPositions)
    .values({ userId: input.userId, postId: input.post.id, progress: input.progress, anchor: input.anchor })
    .onConflictDoUpdate({
      target: [blogReadingPositions.userId, blogReadingPositions.postId],
      set: { progress: input.progress, anchor: input.anchor, updatedAt: sql`now()` },
    })
    .returning({
      progress: blogReadingPositions.progress,
      anchor: blogReadingPositions.anchor,
      updatedAt: blogReadingPositions.updatedAt,
    });
  return { slug: input.slug, title: input.post.title, ...(row as Omit<BlogReadingPosition, "slug" | "title">) };
}
