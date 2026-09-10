// src/modules/practice/plans-repo.ts
// Training plans (SHAN-468, Phase 1 of SHAN-467): a goal-driven skeleton of
// days > blocks > steps, plus the per-date completion tally. Every write is
// scoped to an owner id by the caller; nothing here trusts a bare plan id.
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  trainingPlanBlocks,
  trainingPlanCompletions,
  trainingPlanDays,
  trainingPlanSteps,
  trainingPlans,
} from "@/db/schema";

export const PLAN_STATUSES = ["draft", "active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_VISIBILITIES = ["private", "public"] as const;
export type PlanVisibility = (typeof PLAN_VISIBILITIES)[number];

export const BLOCK_KINDS = [
  "warmup",
  "skill",
  "drill",
  "strength",
  "conditioning",
  "mobility",
  "cooldown",
  "other",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_MODES = ["time", "reps"] as const;
export type BlockMode = (typeof BLOCK_MODES)[number];

export interface PlanRow {
  id: string;
  userId: string;
  slug: string;
  title: string;
  goal: string | null;
  description: string | null;
  discipline: string | null;
  status: string;
  visibility: string;
  startDate: string | null;
  daysPerWeek: number | null;
  sessionTime: string | null;
  reminderMinutes: number | null;
  icsToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DayRow {
  id: string;
  planId: string;
  position: number;
  label: string;
  weekday: number | null;
  notes: string | null;
}

export interface BlockRow {
  id: string;
  dayId: string;
  position: number;
  title: string;
  kind: string;
  mode: string;
  targetSeconds: number | null;
  targetReps: number | null;
  sets: number;
  restSeconds: number;
  notes: string | null;
}

export interface StepRow {
  id: string;
  blockId: string;
  position: number;
  text: string;
  reps: number | null;
  durationSeconds: number | null;
}

// ----- Plans -----

export async function slugTaken(userId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: trainingPlans.id })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.slug, slug)))
    .limit(1);
  return Boolean(row);
}

export async function createPlan(input: {
  userId: string;
  slug: string;
  title: string;
  goal: string | null;
  description: string | null;
  discipline: string | null;
  status: PlanStatus;
  visibility: PlanVisibility;
  startDate: string | null;
  daysPerWeek: number | null;
}): Promise<PlanRow> {
  const [row] = await db.insert(trainingPlans).values(input).returning();
  return row as PlanRow;
}

export async function listPlans(
  userId: string,
  opts: { status?: PlanStatus; limit: number } = { limit: 50 },
): Promise<PlanRow[]> {
  const conditions = [eq(trainingPlans.userId, userId)];
  if (opts.status) conditions.push(eq(trainingPlans.status, opts.status));
  const rows = await db
    .select()
    .from(trainingPlans)
    .where(and(...conditions))
    .orderBy(desc(trainingPlans.updatedAt))
    .limit(opts.limit);
  return rows as PlanRow[];
}

export async function getPlanById(planId: string): Promise<PlanRow | null> {
  const [row] = await db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.id, planId))
    .limit(1);
  return (row as PlanRow) ?? null;
}

/**
 * Look a plan up by its calendar-feed token. The token is the only credential
 * the .ics route has — subscribers are calendar servers, not logged-in
 * browsers — so this is deliberately the one lookup that is not user-scoped.
 */
export async function getPlanByIcsToken(token: string): Promise<PlanRow | null> {
  const [row] = await db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.icsToken, token))
    .limit(1);
  return (row as PlanRow) ?? null;
}

export async function getPlanBySlug(userId: string, slug: string): Promise<PlanRow | null> {
  const [row] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.slug, slug)))
    .limit(1);
  return (row as PlanRow) ?? null;
}

export async function updatePlan(
  planId: string,
  patch: Partial<{
    title: string;
    goal: string | null;
    description: string | null;
    discipline: string | null;
    status: PlanStatus;
    visibility: PlanVisibility;
    startDate: string | null;
    daysPerWeek: number | null;
    sessionTime: string | null;
    reminderMinutes: number | null;
    icsToken: string | null;
  }>,
): Promise<PlanRow | null> {
  const [row] = await db
    .update(trainingPlans)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(trainingPlans.id, planId))
    .returning();
  return (row as PlanRow) ?? null;
}

/** Bumps updatedAt so the plan list re-sorts when a nested day/block/step changes. */
export async function touchPlan(planId: string): Promise<void> {
  await db
    .update(trainingPlans)
    .set({ updatedAt: new Date() })
    .where(eq(trainingPlans.id, planId));
}

export async function deletePlan(planId: string): Promise<boolean> {
  const rows = await db
    .delete(trainingPlans)
    .where(eq(trainingPlans.id, planId))
    .returning({ id: trainingPlans.id });
  return rows.length > 0;
}

// ----- Days -----

/** Next 1-based position for a new day, so callers never have to pass one. */
export async function nextDayPosition(planId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${trainingPlanDays.position})` })
    .from(trainingPlanDays)
    .where(eq(trainingPlanDays.planId, planId));
  return (row?.max ?? 0) + 1;
}

export async function createDay(input: {
  planId: string;
  position: number;
  label: string;
  weekday: number | null;
  notes: string | null;
}): Promise<DayRow> {
  const [row] = await db.insert(trainingPlanDays).values(input).returning();
  return row as DayRow;
}

export async function getDay(dayId: string): Promise<DayRow | null> {
  const [row] = await db
    .select()
    .from(trainingPlanDays)
    .where(eq(trainingPlanDays.id, dayId))
    .limit(1);
  return (row as DayRow) ?? null;
}

export async function updateDay(
  dayId: string,
  patch: Partial<{ position: number; label: string; weekday: number | null; notes: string | null }>,
): Promise<DayRow | null> {
  const [row] = await db
    .update(trainingPlanDays)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(trainingPlanDays.id, dayId))
    .returning();
  return (row as DayRow) ?? null;
}

export async function deleteDay(dayId: string): Promise<boolean> {
  const rows = await db
    .delete(trainingPlanDays)
    .where(eq(trainingPlanDays.id, dayId))
    .returning({ id: trainingPlanDays.id });
  return rows.length > 0;
}

// ----- Blocks -----

export async function nextBlockPosition(dayId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${trainingPlanBlocks.position})` })
    .from(trainingPlanBlocks)
    .where(eq(trainingPlanBlocks.dayId, dayId));
  return (row?.max ?? 0) + 1;
}

export async function createBlock(input: {
  dayId: string;
  position: number;
  title: string;
  kind: BlockKind;
  mode: BlockMode;
  targetSeconds: number | null;
  targetReps: number | null;
  sets: number;
  restSeconds: number;
  notes: string | null;
}): Promise<BlockRow> {
  const [row] = await db.insert(trainingPlanBlocks).values(input).returning();
  return row as BlockRow;
}

export async function getBlock(blockId: string): Promise<BlockRow | null> {
  const [row] = await db
    .select()
    .from(trainingPlanBlocks)
    .where(eq(trainingPlanBlocks.id, blockId))
    .limit(1);
  return (row as BlockRow) ?? null;
}

export async function updateBlock(
  blockId: string,
  patch: Partial<{
    position: number;
    title: string;
    kind: BlockKind;
    mode: BlockMode;
    targetSeconds: number | null;
    targetReps: number | null;
    sets: number;
    restSeconds: number;
    notes: string | null;
  }>,
): Promise<BlockRow | null> {
  const [row] = await db
    .update(trainingPlanBlocks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(trainingPlanBlocks.id, blockId))
    .returning();
  return (row as BlockRow) ?? null;
}

export async function deleteBlock(blockId: string): Promise<boolean> {
  const rows = await db
    .delete(trainingPlanBlocks)
    .where(eq(trainingPlanBlocks.id, blockId))
    .returning({ id: trainingPlanBlocks.id });
  return rows.length > 0;
}

// ----- Steps -----

/**
 * Replace a block's entire step list. Agents author steps as a list (10 neck
 * circles, 10 hip openers, 10 hollow rocks), so a whole-list PUT is far less
 * error-prone than per-step CRUD with hand-managed positions.
 */
export async function replaceSteps(
  blockId: string,
  steps: { text: string; reps: number | null; durationSeconds: number | null }[],
): Promise<StepRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(trainingPlanSteps).where(eq(trainingPlanSteps.blockId, blockId));
    if (steps.length === 0) return [];
    const rows = await tx
      .insert(trainingPlanSteps)
      .values(steps.map((s, i) => ({ ...s, blockId, position: i + 1 })))
      .returning();
    return rows as StepRow[];
  });
}

// ----- Tree read -----

export interface PlanTree extends PlanRow {
  days: (DayRow & { blocks: (BlockRow & { steps: StepRow[] })[] })[];
}

/** One plan with every day, block and step, ordered by position. Four queries. */
export async function getPlanTree(plan: PlanRow): Promise<PlanTree> {
  const days = (await db
    .select()
    .from(trainingPlanDays)
    .where(eq(trainingPlanDays.planId, plan.id))
    .orderBy(asc(trainingPlanDays.position))) as DayRow[];

  const dayIds = days.map((d) => d.id);
  const blocks = dayIds.length
    ? ((await db
        .select()
        .from(trainingPlanBlocks)
        .where(inArray(trainingPlanBlocks.dayId, dayIds))
        .orderBy(asc(trainingPlanBlocks.position))) as BlockRow[])
    : [];

  const blockIds = blocks.map((b) => b.id);
  const steps = blockIds.length
    ? ((await db
        .select()
        .from(trainingPlanSteps)
        .where(inArray(trainingPlanSteps.blockId, blockIds))
        .orderBy(asc(trainingPlanSteps.position))) as StepRow[])
    : [];

  const stepsByBlock = new Map<string, StepRow[]>();
  for (const s of steps) {
    const list = stepsByBlock.get(s.blockId);
    if (list) list.push(s);
    else stepsByBlock.set(s.blockId, [s]);
  }
  const blocksByDay = new Map<string, (BlockRow & { steps: StepRow[] })[]>();
  for (const b of blocks) {
    const withSteps = { ...b, steps: stepsByBlock.get(b.id) ?? [] };
    const list = blocksByDay.get(b.dayId);
    if (list) list.push(withSteps);
    else blocksByDay.set(b.dayId, [withSteps]);
  }

  return {
    ...plan,
    days: days.map((d) => ({ ...d, blocks: blocksByDay.get(d.id) ?? [] })),
  };
}

// ----- Completions (the tally) -----

export interface CompletionRow {
  id: string;
  userId: string;
  planId: string;
  blockId: string;
  isoDate: string;
  setsCompleted: number;
  elapsedSeconds: number;
  completedAt: Date | null;
}

/**
 * Idempotent per (user, block, date) — the Phase 3 runner syncs mid-set, so a
 * repeat POST updates the same row instead of stacking duplicates.
 */
export async function upsertCompletion(input: {
  userId: string;
  planId: string;
  blockId: string;
  isoDate: string;
  setsCompleted: number;
  elapsedSeconds: number;
  completedAt: Date | null;
}): Promise<CompletionRow> {
  const [row] = await db
    .insert(trainingPlanCompletions)
    .values(input)
    .onConflictDoUpdate({
      target: [
        trainingPlanCompletions.userId,
        trainingPlanCompletions.blockId,
        trainingPlanCompletions.isoDate,
      ],
      set: {
        setsCompleted: input.setsCompleted,
        elapsedSeconds: input.elapsedSeconds,
        completedAt: input.completedAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as CompletionRow;
}

export async function listCompletions(
  planId: string,
  userId: string,
  range: { from?: string; to?: string } = {},
): Promise<CompletionRow[]> {
  const conditions = [
    eq(trainingPlanCompletions.planId, planId),
    eq(trainingPlanCompletions.userId, userId),
  ];
  if (range.from) conditions.push(gte(trainingPlanCompletions.isoDate, range.from));
  if (range.to) conditions.push(lte(trainingPlanCompletions.isoDate, range.to));
  const rows = await db
    .select()
    .from(trainingPlanCompletions)
    .where(and(...conditions))
    .orderBy(desc(trainingPlanCompletions.isoDate));
  return rows as CompletionRow[];
}

export async function deleteCompletion(
  userId: string,
  blockId: string,
  isoDate: string,
): Promise<boolean> {
  const rows = await db
    .delete(trainingPlanCompletions)
    .where(
      and(
        eq(trainingPlanCompletions.userId, userId),
        eq(trainingPlanCompletions.blockId, blockId),
        eq(trainingPlanCompletions.isoDate, isoDate),
      ),
    )
    .returning({ id: trainingPlanCompletions.id });
  return rows.length > 0;
}
