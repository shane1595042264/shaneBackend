// SHAN-596: storage for readers' AI keys, their AI settings and usage events.
// Column refs stay inside the functions: route tests mock @/db/schema
// partially, and a top-level `table.col` would throw at import.

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { aiUsageEvents, userAiKeys, userAiSettings } from "@/db/schema";
import type { AiProvider } from "./detect";

export interface KeyRow {
  id: string;
  userId: string;
  provider: string;
  keySealed: string;
  keyHint: string;
  models: unknown;
  defaultModel: string;
  preferredModel: string | null;
  status: string;
  lastError: string | null;
  lastCheckedAt: Date;
  createdAt: Date;
}

export interface AiSettings {
  preferredProvider: AiProvider | null;
  notesToKnowledge: boolean;
}

/** The shape the settings page sees: never the sealed key. */
export function publicKey(row: KeyRow) {
  return {
    id: row.id,
    provider: row.provider,
    keyHint: row.keyHint,
    models: Array.isArray(row.models) ? (row.models as string[]) : [],
    defaultModel: row.defaultModel,
    preferredModel: row.preferredModel,
    status: row.status,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
  };
}

export async function listKeys(userId: string): Promise<KeyRow[]> {
  return (await db
    .select()
    .from(userAiKeys)
    .where(eq(userAiKeys.userId, userId))
    .orderBy(asc(userAiKeys.createdAt))) as KeyRow[];
}

export async function getKey(userId: string, id: string): Promise<KeyRow | null> {
  const [row] = await db
    .select()
    .from(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.id, id)));
  return (row as KeyRow) ?? null;
}

/** One key per provider: adding a second Gemini key replaces the first. */
export async function upsertKey(input: {
  userId: string;
  provider: AiProvider;
  keySealed: string;
  keyHint: string;
  models: string[];
  defaultModel: string;
}): Promise<KeyRow> {
  const now = new Date();
  const [row] = await db
    .insert(userAiKeys)
    .values({ ...input, status: "ok", lastError: null, lastCheckedAt: now })
    .onConflictDoUpdate({
      target: [userAiKeys.userId, userAiKeys.provider],
      set: {
        keySealed: input.keySealed,
        keyHint: input.keyHint,
        models: input.models,
        defaultModel: input.defaultModel,
        preferredModel: null,
        status: "ok",
        lastError: null,
        lastCheckedAt: now,
      },
    })
    .returning();
  return row as KeyRow;
}

export async function updateKey(
  userId: string,
  id: string,
  patch: Partial<Pick<KeyRow, "preferredModel" | "status" | "lastError" | "defaultModel" | "models" | "lastCheckedAt">>
): Promise<KeyRow | null> {
  const [row] = await db
    .update(userAiKeys)
    .set(patch)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.id, id)))
    .returning();
  return (row as KeyRow) ?? null;
}

export async function deleteKey(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.id, id)))
    .returning({ id: userAiKeys.id });
  return rows.length > 0;
}

export async function getSettings(userId: string): Promise<AiSettings> {
  const [row] = await db.select().from(userAiSettings).where(eq(userAiSettings.userId, userId));
  return {
    preferredProvider: (row?.preferredProvider as AiProvider | null | undefined) ?? null,
    notesToKnowledge: row?.notesToKnowledge ?? true,
  };
}

export async function saveSettings(userId: string, patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await getSettings(userId);
  const next = { ...current, ...patch };
  await db
    .insert(userAiSettings)
    .values({ userId, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userAiSettings.userId, set: { ...next, updatedAt: new Date() } });
  return next;
}

export async function recordUsage(input: {
  userId: string;
  provider: AiProvider;
  model: string;
  feature: "explain" | "validate";
  surface?: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
}): Promise<void> {
  try {
    await db.insert(aiUsageEvents).values({ ...input, surface: input.surface ?? null });
  } catch (err) {
    // Losing a usage row must never fail the explanation it describes.
    console.error("[ai] failed to record usage:", (err as Error).message);
  }
}

export async function usageSummary(userId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const where = and(eq(aiUsageEvents.userId, userId), gte(aiUsageEvents.createdAt, since));
  const [totals, byModel, daily, recent] = await Promise.all([
    db
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::int`,
      })
      .from(aiUsageEvents)
      .where(where),
    db
      .select({
        provider: aiUsageEvents.provider,
        model: aiUsageEvents.model,
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`sum(${aiUsageEvents.inputTokens})::int`,
        outputTokens: sql<number>`sum(${aiUsageEvents.outputTokens})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::int`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.provider, aiUsageEvents.model)
      .orderBy(desc(sql`sum(${aiUsageEvents.inputTokens}) + sum(${aiUsageEvents.outputTokens})`)),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${aiUsageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        provider: aiUsageEvents.provider,
        tokens: sql<number>`sum(${aiUsageEvents.inputTokens} + ${aiUsageEvents.outputTokens})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::int`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(sql`1`, aiUsageEvents.provider)
      .orderBy(sql`1`),
    db
      .select({
        id: aiUsageEvents.id,
        provider: aiUsageEvents.provider,
        model: aiUsageEvents.model,
        feature: aiUsageEvents.feature,
        surface: aiUsageEvents.surface,
        inputTokens: aiUsageEvents.inputTokens,
        outputTokens: aiUsageEvents.outputTokens,
        costMicroUsd: aiUsageEvents.costMicroUsd,
        createdAt: aiUsageEvents.createdAt,
      })
      .from(aiUsageEvents)
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(25),
  ]);
  return { days, totals: totals[0], byModel, daily, recent };
}
