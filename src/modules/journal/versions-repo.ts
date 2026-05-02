import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalVersions } from "@/db/schema";
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

export async function listVersions(entryId: string) {
  return db
    .select()
    .from(journalVersions)
    .where(eq(journalVersions.entryId, entryId))
    .orderBy(desc(journalVersions.versionNum));
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
