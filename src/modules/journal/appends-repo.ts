import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { journalAppends, users } from "@/db/schema";

export async function createAppend(input: {
  entryId: string;
  authorId: string;
  content: string;
}) {
  const [row] = await db
    .insert(journalAppends)
    .values({
      entryId: input.entryId,
      authorId: input.authorId,
      content: input.content,
    })
    .returning();
  return row;
}

export async function listAppendsForEntry(entryId: string) {
  const rows = await db
    .select({
      id: journalAppends.id,
      entryId: journalAppends.entryId,
      authorId: journalAppends.authorId,
      content: journalAppends.content,
      createdAt: journalAppends.createdAt,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(journalAppends)
    .leftJoin(users, eq(users.id, journalAppends.authorId))
    .where(eq(journalAppends.entryId, entryId))
    .orderBy(asc(journalAppends.createdAt));

  return rows.map(({ authorName, authorAvatarUrl, ...rest }) => ({
    ...rest,
    author: { id: rest.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  }));
}
