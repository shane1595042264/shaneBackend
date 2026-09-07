import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalVersions, users } from "@/db/schema";
import { hashContent } from "./entries-repo";

export class VersionConflictError extends Error {
  constructor(public currentVersionNum: number) {
    super("VersionConflict");
    this.name = "VersionConflict";
  }
}

interface AppendInput {
  entryId: string;
  editorId: string;
  content: string;
  ifMatchVersionNum: number;
  source?: "direct" | "suggestion" | "revert";
  suggestionId?: string;
}

export async function appendDirectVersion(input: AppendInput) {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ versionNum: journalVersions.versionNum, id: journalVersions.id })
      .from(journalVersions)
      .where(eq(journalVersions.entryId, input.entryId))
      .orderBy(desc(journalVersions.versionNum))
      .limit(1);

    if (!latest || latest.versionNum !== input.ifMatchVersionNum) {
      throw new VersionConflictError(latest?.versionNum ?? 0);
    }

    const [version] = await tx
      .insert(journalVersions)
      .values({
        entryId: input.entryId,
        versionNum: latest.versionNum + 1,
        content: input.content,
        contentHash: hashContent(input.content),
        editorId: input.editorId,
        source: input.source ?? "direct",
        suggestionId: input.suggestionId,
        parentVersionId: latest.id,
      })
      .returning();

    await tx
      .update(journalEntries)
      .set({
        currentVersionId: version.id,
        editCount: sql`${journalEntries.editCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, input.entryId));

    return version;
  });
}

// Every column of journal_versions EXCEPT `content`. Versions are append-only
// and never pruned, so a list built with getTableColumns() carried one full copy
// of the entry body per edit and grew without bound (SHAN-461). Callers that
// need a body read it from GET /entries/:date/versions/:num, one at a time.
const versionListColumns = {
  id: journalVersions.id,
  entryId: journalVersions.entryId,
  versionNum: journalVersions.versionNum,
  contentHash: journalVersions.contentHash,
  editorId: journalVersions.editorId,
  source: journalVersions.source,
  suggestionId: journalVersions.suggestionId,
  parentVersionId: journalVersions.parentVersionId,
  createdAt: journalVersions.createdAt,
};

export async function listVersions(
  entryId: string,
  opts: { limit: number; cursor?: number }
) {
  const conditions = [eq(journalVersions.entryId, entryId)];
  // Keyset on versionNum rather than createdAt (the cursor column everywhere
  // else): it is unique per entry, dense from 1, and already the sort key, so
  // it can't skip or repeat a row the way a shared timestamp can.
  if (opts.cursor !== undefined) {
    conditions.push(lt(journalVersions.versionNum, opts.cursor));
  }
  const rows = await db
    .select({
      ...versionListColumns,
      editorName: users.name,
      editorAvatarUrl: users.avatarUrl,
    })
    .from(journalVersions)
    .leftJoin(users, eq(users.id, journalVersions.editorId))
    .where(and(...conditions))
    .orderBy(desc(journalVersions.versionNum))
    .limit(opts.limit);
  return rows.map(({ editorName, editorAvatarUrl, ...version }) => ({
    ...version,
    editor: { id: version.editorId, name: editorName, avatarUrl: editorAvatarUrl },
  }));
}

export async function getVersion(entryId: string, versionNum: number) {
  const [row] = await db
    .select()
    .from(journalVersions)
    .where(and(eq(journalVersions.entryId, entryId), eq(journalVersions.versionNum, versionNum)))
    .limit(1);
  return row ?? null;
}

export async function revertToVersion(
  entryId: string,
  targetVersionNum: number,
  editorId: string,
  ifMatchVersionNum: number
) {
  const target = await getVersion(entryId, targetVersionNum);
  if (!target) throw new Error("Target version not found");
  return appendDirectVersion({
    entryId,
    editorId,
    content: target.content,
    ifMatchVersionNum,
    source: "revert",
  });
}
