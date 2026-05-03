import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalVersions, journalSuggestions } from "@/db/schema";
import { hashContent } from "./entries-repo";
import { VersionConflictError } from "./versions-repo";

export async function createSuggestion(input: {
  entryId: string;
  proposerId: string;
  baseVersionId: string;
  proposedContent: string;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(journalSuggestions)
      .values({
        entryId: input.entryId,
        proposerId: input.proposerId,
        baseVersionId: input.baseVersionId,
        proposedContent: input.proposedContent,
      })
      .returning();
    await tx
      .update(journalEntries)
      .set({
        pendingSuggestionCount: sql`${journalEntries.pendingSuggestionCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, input.entryId));
    return row;
  });
}

export async function getSuggestion(id: string) {
  const [row] = await db
    .select()
    .from(journalSuggestions)
    .where(eq(journalSuggestions.id, id))
    .limit(1);
  return row ?? null;
}

export async function listSuggestionsForEntry(entryId: string, status?: string) {
  const where = status
    ? and(eq(journalSuggestions.entryId, entryId), eq(journalSuggestions.status, status as any))
    : eq(journalSuggestions.entryId, entryId);
  return db
    .select()
    .from(journalSuggestions)
    .where(where)
    .orderBy(desc(journalSuggestions.createdAt));
}

export async function inboxFor(authorId: string) {
  return db
    .select({
      suggestion: journalSuggestions,
      entry: journalEntries,
    })
    .from(journalSuggestions)
    .innerJoin(journalEntries, eq(journalEntries.id, journalSuggestions.entryId))
    .where(and(eq(journalEntries.authorId, authorId), eq(journalSuggestions.status, "pending")))
    .orderBy(desc(journalSuggestions.createdAt));
}

export async function approveSuggestion(suggestionId: string, authorId: string, ifMatchVersionNum: number) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(journalSuggestions)
      .where(eq(journalSuggestions.id, suggestionId))
      .limit(1);
    if (!s || s.status !== "pending") throw new Error("Suggestion not pending");

    const [latest] = await tx
      .select({ id: journalVersions.id, versionNum: journalVersions.versionNum })
      .from(journalVersions)
      .where(eq(journalVersions.entryId, s.entryId))
      .orderBy(desc(journalVersions.versionNum))
      .limit(1);

    if (!latest || latest.versionNum !== ifMatchVersionNum) {
      throw new VersionConflictError(latest?.versionNum ?? 0);
    }

    const [version] = await tx
      .insert(journalVersions)
      .values({
        entryId: s.entryId,
        versionNum: latest.versionNum + 1,
        content: s.proposedContent,
        contentHash: hashContent(s.proposedContent),
        editorId: s.proposerId,
        source: "suggestion",
        suggestionId: s.id,
        parentVersionId: latest.id,
      })
      .returning();

    await tx
      .update(journalEntries)
      .set({
        currentVersionId: version.id,
        editCount: sql`${journalEntries.editCount} + 1`,
        pendingSuggestionCount: sql`${journalEntries.pendingSuggestionCount} - 1`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, s.entryId));

    await tx
      .update(journalSuggestions)
      .set({ status: "approved", decidedBy: authorId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(journalSuggestions.id, s.id));

    return version;
  });
}

export async function rejectSuggestion(suggestionId: string, authorId: string, reason?: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(journalSuggestions)
      .where(eq(journalSuggestions.id, suggestionId))
      .limit(1);
    if (!s || s.status !== "pending") throw new Error("Suggestion not pending");
    await tx
      .update(journalSuggestions)
      .set({ status: "rejected", decidedBy: authorId, decidedAt: new Date(), rejectionReason: reason, updatedAt: new Date() })
      .where(eq(journalSuggestions.id, s.id));
    await tx
      .update(journalEntries)
      .set({
        pendingSuggestionCount: sql`${journalEntries.pendingSuggestionCount} - 1`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, s.entryId));
    return s;
  });
}

export async function withdrawSuggestion(suggestionId: string, proposerId: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(journalSuggestions)
      .where(and(eq(journalSuggestions.id, suggestionId), eq(journalSuggestions.proposerId, proposerId)))
      .limit(1);
    if (!s || s.status !== "pending") throw new Error("Cannot withdraw");
    await tx
      .update(journalSuggestions)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(eq(journalSuggestions.id, s.id));
    await tx
      .update(journalEntries)
      .set({
        pendingSuggestionCount: sql`${journalEntries.pendingSuggestionCount} - 1`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, s.entryId));
    return s;
  });
}
