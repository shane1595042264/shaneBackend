// src/modules/blog/versions-repo.ts
//
// SHAN-478 Phase 1. Mirrors journal/versions-repo.ts. The one addition is
// that a blog version carries a title as well as a body, so an edit that
// renames the post is recorded (and revertible) like any other edit.
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { blogPosts, blogVersions, users } from "@/db/schema";
import { hashContent } from "./posts-repo";

export class VersionConflictError extends Error {
  constructor(public currentVersionNum: number) {
    super("VersionConflict");
    this.name = "VersionConflict";
  }
}

interface AppendInput {
  postId: string;
  editorId: string;
  title: string;
  content: string;
  /** Optimistic concurrency: the version the editor based their edit on. */
  ifMatchVersionNum: number;
  source?: "direct" | "revert";
}

export async function appendDirectVersion(input: AppendInput) {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ versionNum: blogVersions.versionNum, id: blogVersions.id })
      .from(blogVersions)
      .where(eq(blogVersions.postId, input.postId))
      .orderBy(desc(blogVersions.versionNum))
      .limit(1);

    if (!latest || latest.versionNum !== input.ifMatchVersionNum) {
      throw new VersionConflictError(latest?.versionNum ?? 0);
    }

    const [version] = await tx
      .insert(blogVersions)
      .values({
        postId: input.postId,
        versionNum: latest.versionNum + 1,
        title: input.title,
        content: input.content,
        contentHash: hashContent(input.content),
        editorId: input.editorId,
        source: input.source ?? "direct",
        parentVersionId: latest.id,
      })
      .returning();

    await tx
      .update(blogPosts)
      .set({
        currentVersionId: version.id,
        // Denormalized copy so the list query never joins blog_versions for
        // a title. Kept in step here, inside the same transaction.
        title: input.title,
        editCount: sql`${blogPosts.editCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(blogPosts.id, input.postId));

    return version;
  });
}

// Every column EXCEPT `content`. Versions are append-only and never pruned,
// so selecting the body for each row of a list carries one full copy of the
// post per edit (the bug fixed for the journal in SHAN-461). Callers that
// need a body read it one at a time from GET /posts/:slug/versions/:num.
const versionListColumns = {
  id: blogVersions.id,
  postId: blogVersions.postId,
  versionNum: blogVersions.versionNum,
  title: blogVersions.title,
  contentHash: blogVersions.contentHash,
  editorId: blogVersions.editorId,
  source: blogVersions.source,
  parentVersionId: blogVersions.parentVersionId,
  createdAt: blogVersions.createdAt,
};

export async function listVersions(postId: string, opts: { limit: number; cursor?: number }) {
  const conditions = [eq(blogVersions.postId, postId)];
  // Keyset on versionNum: unique per post, dense from 1, and already the sort
  // key, so it cannot skip or repeat a row the way a shared timestamp can.
  if (opts.cursor !== undefined) {
    conditions.push(lt(blogVersions.versionNum, opts.cursor));
  }
  const rows = await db
    .select({
      ...versionListColumns,
      editorName: users.name,
      editorAvatarUrl: users.avatarUrl,
    })
    .from(blogVersions)
    .leftJoin(users, eq(users.id, blogVersions.editorId))
    .where(and(...conditions))
    .orderBy(desc(blogVersions.versionNum))
    .limit(opts.limit);
  return rows.map(({ editorName, editorAvatarUrl, ...version }) => ({
    ...version,
    editor: { id: version.editorId, name: editorName, avatarUrl: editorAvatarUrl },
  }));
}

export async function getVersion(postId: string, versionNum: number) {
  const [row] = await db
    .select()
    .from(blogVersions)
    .where(and(eq(blogVersions.postId, postId), eq(blogVersions.versionNum, versionNum)))
    .limit(1);
  return row ?? null;
}

export async function revertToVersion(
  postId: string,
  targetVersionNum: number,
  editorId: string,
  ifMatchVersionNum: number
) {
  const target = await getVersion(postId, targetVersionNum);
  if (!target) throw new Error("Target version not found");
  return appendDirectVersion({
    postId,
    editorId,
    title: target.title,
    content: target.content,
    ifMatchVersionNum,
    source: "revert",
  });
}
