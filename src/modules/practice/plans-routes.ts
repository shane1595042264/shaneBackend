// src/modules/practice/plans-routes.ts
// Training plans API (SHAN-468, Phase 1 of SHAN-467), mounted at
// /api/practice/plans. Designed agent-first: POST /plans accepts a fully
// nested days > blocks > steps payload so a PAT-holding agent can author an
// entire training plan in one request, and every nested resource is addressed
// under its plan so ownership is a single check.
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@/modules/shared/zod-validator";
import { requireAuth, optionalAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { generateUniqueSlug } from "@/modules/trips/slug";
import { isoDate, trimmedRequired, trimmedNullish } from "@/modules/shared/validators";
import {
  BLOCK_KINDS,
  BLOCK_MODES,
  PLAN_STATUSES,
  PLAN_VISIBILITIES,
  createBlock,
  createDay,
  createPlan,
  deleteBlock,
  deleteCompletion,
  deleteDay,
  deletePlan,
  getBlock,
  getDay,
  getPlanById,
  getPlanByIcsToken,
  getPlanTree,
  listCompletions,
  listPlans,
  nextBlockPosition,
  nextDayPosition,
  replaceSteps,
  slugTaken,
  touchPlan,
  updateBlock,
  updateDay,
  updatePlan,
  upsertCompletion,
  type PlanRow,
} from "./plans-repo";
import { buildPlanIcs } from "./plan-ics";

// Per-PAT rolling-60s limits. Authoring a plan is a handful of calls; the
// completion tally is written by the runner as the user works through a day,
// so it gets the larger bucket (parity with practice-session-items-sync).
const plansWriteLimit = createPATRateLimit({ bucket: "practice-plans-write", limitPerMinute: 60 });
const completionsWriteLimit = createPATRateLimit({
  bucket: "practice-plan-completions-write",
  limitPerMinute: 120,
});

export const planRoutes = new Hono();

const planIdParam = z.object({ planId: z.string().uuid() });
const dayIdParam = planIdParam.extend({ dayId: z.string().uuid() });
const blockIdParam = dayIdParam.extend({ blockId: z.string().uuid() });

/** Local clock time a session starts, "HH:MM" on a 24h clock. */
const sessionTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "sessionTime must be HH:MM");

/** Minutes before the session to alert. 0 = at start, capped at a day out. */
const reminderMinutes = z.number().int().min(0).max(1440);

const stepInput = z.object({
  text: trimmedRequired(300),
  reps: z.number().int().min(1).max(1000).nullish().default(null),
  durationSeconds: z.number().int().min(1).max(86_400).nullish().default(null),
});

const blockInput = z.object({
  title: trimmedRequired(160),
  kind: z.enum(BLOCK_KINDS).default("other"),
  mode: z.enum(BLOCK_MODES).default("time"),
  targetSeconds: z.number().int().min(1).max(86_400).nullish().default(null),
  targetReps: z.number().int().min(1).max(1000).nullish().default(null),
  sets: z.number().int().min(1).max(100).default(1),
  restSeconds: z.number().int().min(0).max(3600).default(0),
  notes: trimmedNullish(2000),
  steps: z.array(stepInput).max(50).optional(),
});

const dayInput = z.object({
  label: trimmedRequired(120),
  // 0 = Sunday .. 6 = Saturday. Null means "the next session" rather than a
  // fixed weekday, which is how a 3x-a-week plan without pinned days reads.
  weekday: z.number().int().min(0).max(6).nullish().default(null),
  notes: trimmedNullish(2000),
  blocks: z.array(blockInput).max(50).optional(),
});

const planCreateSchema = z.object({
  title: trimmedRequired(160),
  goal: trimmedNullish(2000),
  description: trimmedNullish(5000),
  discipline: trimmedNullish(60),
  status: z.enum(PLAN_STATUSES).default("draft"),
  visibility: z.enum(PLAN_VISIBILITIES).default("private"),
  startDate: isoDate.nullish().default(null),
  daysPerWeek: z.number().int().min(1).max(7).nullish().default(null),
  days: z.array(dayInput).max(60).optional(),
});

const planPatchSchema = z
  .object({
    title: trimmedRequired(160).optional(),
    goal: trimmedNullish(2000),
    description: trimmedNullish(5000),
    discipline: trimmedNullish(60),
    status: z.enum(PLAN_STATUSES).optional(),
    visibility: z.enum(PLAN_VISIBILITIES).optional(),
    startDate: isoDate.nullish(),
    daysPerWeek: z.number().int().min(1).max(7).nullish(),
    sessionTime: sessionTime.nullish(),
    reminderMinutes: reminderMinutes.nullish(),
    // Note: nested `days` authoring is create-only. A PATCH carrying days is
    // stripped by zod rather than applied — edit days via the /days routes.
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  });

// ----- Plans -----

const listQuery = z.object({
  status: z.enum(PLAN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

planRoutes.get("/", requireAuth, zValidator("query", listQuery), async (c) => {
  const userId = c.get("userId") as string;
  const { status, limit } = c.req.valid("query");
  const plans = await listPlans(userId, { status, limit: limit ?? 50 });
  return c.json({ plans });
});

planRoutes.post(
  "/",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("json", planCreateSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const body = c.req.valid("json");
    const slug = await generateUniqueSlug(body.title, (s) => slugTaken(userId, s));

    const plan = await createPlan({
      userId,
      slug,
      title: body.title,
      goal: body.goal ?? null,
      description: body.description ?? null,
      discipline: body.discipline ?? null,
      status: body.status,
      visibility: body.visibility,
      startDate: body.startDate ?? null,
      daysPerWeek: body.daysPerWeek ?? null,
    });

    // Nested authoring: positions come from array order, so an agent never has
    // to compute them. Written sequentially rather than in one transaction
    // because each level needs the parent id returned by the previous insert.
    for (const [dayIdx, day] of (body.days ?? []).entries()) {
      const dayRow = await createDay({
        planId: plan.id,
        position: dayIdx + 1,
        label: day.label,
        weekday: day.weekday ?? null,
        notes: day.notes ?? null,
      });
      for (const [blockIdx, block] of (day.blocks ?? []).entries()) {
        const blockRow = await createBlock({
          dayId: dayRow.id,
          position: blockIdx + 1,
          title: block.title,
          kind: block.kind,
          mode: block.mode,
          targetSeconds: block.targetSeconds ?? null,
          targetReps: block.targetReps ?? null,
          sets: block.sets,
          restSeconds: block.restSeconds,
          notes: block.notes ?? null,
        });
        if (block.steps?.length) {
          await replaceSteps(
            blockRow.id,
            block.steps.map((s) => ({
              text: s.text,
              reps: s.reps ?? null,
              durationSeconds: s.durationSeconds ?? null,
            })),
          );
        }
      }
    }

    return c.json({ plan: await getPlanTree(plan) }, 201);
  },
);

/**
 * Resolve a plan for a read. Public plans are readable by anyone (including
 * anonymous callers); private plans only by their owner. Returns null for both
 * "missing" and "not yours" so a private plan id is not confirmable.
 */
async function planForRead(planId: string, userId: string | null): Promise<PlanRow | null> {
  const plan = await getPlanById(planId);
  if (!plan) return null;
  if (plan.visibility === "public") return plan;
  return plan.userId === userId ? plan : null;
}

async function planForWrite(planId: string, userId: string): Promise<PlanRow | null> {
  const plan = await getPlanById(planId);
  if (!plan || plan.userId !== userId) return null;
  return plan;
}

planRoutes.get("/:planId", optionalAuth, zValidator("param", planIdParam), async (c) => {
  const userId = (c.get("userId") as string | null) ?? null;
  const plan = await planForRead(c.req.valid("param").planId, userId);
  if (!plan) return c.json({ error: "Not found" }, 404);
  const tree = await getPlanTree(plan);
  // The feed token is a bearer credential. A public plan is readable by
  // anyone, so it must never travel in a read that is not the owner's.
  return c.json({ plan: plan.userId === userId ? tree : { ...tree, icsToken: null } });
});

planRoutes.patch(
  "/:planId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", planIdParam),
  zValidator("json", planPatchSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    const plan = await updatePlan(planId, c.req.valid("json"));
    if (!plan) return c.json({ error: "Not found" }, 404);
    return c.json({ plan });
  },
);

planRoutes.delete(
  "/:planId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", planIdParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    await deletePlan(planId);
    return c.body(null, 204);
  },
);

// ----- Days -----

planRoutes.post(
  "/:planId/days",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", planIdParam),
  zValidator("json", dayInput.omit({ blocks: true })),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    const body = c.req.valid("json");
    const day = await createDay({
      planId,
      position: await nextDayPosition(planId),
      label: body.label,
      weekday: body.weekday ?? null,
      notes: body.notes ?? null,
    });
    await touchPlan(planId);
    return c.json({ day }, 201);
  },
);

const dayPatchSchema = z
  .object({
    label: trimmedRequired(120).optional(),
    weekday: z.number().int().min(0).max(6).nullish(),
    notes: trimmedNullish(2000),
    position: z.number().int().min(1).max(1000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

/** Loads a day and confirms it belongs to a plan the caller owns. */
async function ownedDay(planId: string, dayId: string, userId: string) {
  if (!(await planForWrite(planId, userId))) return null;
  const day = await getDay(dayId);
  return day && day.planId === planId ? day : null;
}

planRoutes.patch(
  "/:planId/days/:dayId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", dayIdParam),
  zValidator("json", dayPatchSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId } = c.req.valid("param");
    if (!(await ownedDay(planId, dayId, userId))) return c.json({ error: "Not found" }, 404);
    const day = await updateDay(dayId, c.req.valid("json"));
    await touchPlan(planId);
    return c.json({ day });
  },
);

planRoutes.delete(
  "/:planId/days/:dayId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", dayIdParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId } = c.req.valid("param");
    if (!(await ownedDay(planId, dayId, userId))) return c.json({ error: "Not found" }, 404);
    await deleteDay(dayId);
    await touchPlan(planId);
    return c.body(null, 204);
  },
);

// ----- Blocks -----

planRoutes.post(
  "/:planId/days/:dayId/blocks",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", dayIdParam),
  zValidator("json", blockInput),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId } = c.req.valid("param");
    if (!(await ownedDay(planId, dayId, userId))) return c.json({ error: "Not found" }, 404);
    const body = c.req.valid("json");
    const block = await createBlock({
      dayId,
      position: await nextBlockPosition(dayId),
      title: body.title,
      kind: body.kind,
      mode: body.mode,
      targetSeconds: body.targetSeconds ?? null,
      targetReps: body.targetReps ?? null,
      sets: body.sets,
      restSeconds: body.restSeconds,
      notes: body.notes ?? null,
    });
    const steps = body.steps?.length
      ? await replaceSteps(
          block.id,
          body.steps.map((s) => ({
            text: s.text,
            reps: s.reps ?? null,
            durationSeconds: s.durationSeconds ?? null,
          })),
        )
      : [];
    await touchPlan(planId);
    return c.json({ block: { ...block, steps } }, 201);
  },
);

const blockPatchSchema = z
  .object({
    title: trimmedRequired(160).optional(),
    kind: z.enum(BLOCK_KINDS).optional(),
    mode: z.enum(BLOCK_MODES).optional(),
    targetSeconds: z.number().int().min(1).max(86_400).nullish(),
    targetReps: z.number().int().min(1).max(1000).nullish(),
    sets: z.number().int().min(1).max(100).optional(),
    restSeconds: z.number().int().min(0).max(3600).optional(),
    notes: trimmedNullish(2000),
    position: z.number().int().min(1).max(1000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

/** Loads a block and confirms day + plan ownership all the way up. */
async function ownedBlock(planId: string, dayId: string, blockId: string, userId: string) {
  if (!(await ownedDay(planId, dayId, userId))) return null;
  const block = await getBlock(blockId);
  return block && block.dayId === dayId ? block : null;
}

planRoutes.patch(
  "/:planId/days/:dayId/blocks/:blockId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", blockIdParam),
  zValidator("json", blockPatchSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId, blockId } = c.req.valid("param");
    if (!(await ownedBlock(planId, dayId, blockId, userId)))
      return c.json({ error: "Not found" }, 404);
    const block = await updateBlock(blockId, c.req.valid("json"));
    await touchPlan(planId);
    return c.json({ block });
  },
);

planRoutes.delete(
  "/:planId/days/:dayId/blocks/:blockId",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", blockIdParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId, blockId } = c.req.valid("param");
    if (!(await ownedBlock(planId, dayId, blockId, userId)))
      return c.json({ error: "Not found" }, 404);
    await deleteBlock(blockId);
    await touchPlan(planId);
    return c.body(null, 204);
  },
);

// ----- Steps (whole-list replace) -----

planRoutes.put(
  "/:planId/days/:dayId/blocks/:blockId/steps",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", blockIdParam),
  zValidator("json", z.object({ steps: z.array(stepInput).max(50) })),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId, dayId, blockId } = c.req.valid("param");
    if (!(await ownedBlock(planId, dayId, blockId, userId)))
      return c.json({ error: "Not found" }, 404);
    const steps = await replaceSteps(
      blockId,
      c.req.valid("json").steps.map((s) => ({
        text: s.text,
        reps: s.reps ?? null,
        durationSeconds: s.durationSeconds ?? null,
      })),
    );
    await touchPlan(planId);
    return c.json({ steps });
  },
);

// ----- Completions (the tally) -----

const completionBody = z.object({
  blockId: z.string().uuid(),
  isoDate,
  setsCompleted: z.number().int().min(0).max(500).default(0),
  elapsedSeconds: z.number().int().min(0).max(86_400).default(0),
  // Explicit false clears a previously-recorded completion timestamp without
  // dropping the partial tally, which is what un-checking a block means.
  completed: z.boolean().default(true),
});

planRoutes.post(
  "/:planId/completions",
  requireAuth,
  requireScope("practice:write"),
  completionsWriteLimit,
  zValidator("param", planIdParam),
  zValidator("json", completionBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    const body = c.req.valid("json");

    // The block must live in this plan — otherwise a caller could tally against
    // someone else's block id and poison their history.
    const block = await getBlock(body.blockId);
    const day = block ? await getDay(block.dayId) : null;
    if (!day || day.planId !== planId) return c.json({ error: "Block not in plan" }, 404);

    const completion = await upsertCompletion({
      userId,
      planId,
      blockId: body.blockId,
      isoDate: body.isoDate,
      setsCompleted: body.setsCompleted,
      elapsedSeconds: body.elapsedSeconds,
      completedAt: body.completed ? new Date() : null,
    });
    return c.json({ completion }, 201);
  },
);

const completionsQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

planRoutes.get(
  "/:planId/completions",
  requireAuth,
  zValidator("param", planIdParam),
  zValidator("query", completionsQuery),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForRead(planId, userId))) return c.json({ error: "Not found" }, 404);
    const { from, to } = c.req.valid("query");
    // Always the caller's own tally, even on a public plan.
    const completions = await listCompletions(planId, userId, { from, to });
    return c.json({ completions });
  },
);

// Target comes from the query string, not a body: a DELETE with a payload is
// legal but intermediaries (and the frontend's same-origin rewrite) are allowed
// to drop it, which would silently delete nothing.
planRoutes.delete(
  "/:planId/completions",
  requireAuth,
  requireScope("practice:write"),
  completionsWriteLimit,
  zValidator("param", planIdParam),
  zValidator("query", z.object({ blockId: z.string().uuid(), isoDate })),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    const { blockId, isoDate: date } = c.req.valid("query");
    const ok = await deleteCompletion(userId, blockId, date);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);

// ----- Calendar feed (SHAN-473) -----

/**
 * Mint the plan's .ics token, or rotate it. Minting is idempotent so the
 * "Subscribe" button can be pressed twice without invalidating the URL the
 * user already pasted into Google Calendar; `rotate` is the explicit escape
 * hatch for a leaked feed URL.
 */
planRoutes.post(
  "/:planId/calendar-token",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", planIdParam),
  zValidator("json", z.object({ rotate: z.boolean().default(false) }).optional()),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    const plan = await planForWrite(planId, userId);
    if (!plan) return c.json({ error: "Not found" }, 404);

    const rotate = c.req.valid("json")?.rotate ?? false;
    if (plan.icsToken && !rotate) return c.json({ token: plan.icsToken });

    const updated = await updatePlan(planId, { icsToken: crypto.randomUUID() });
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json({ token: updated.icsToken }, plan.icsToken ? 200 : 201);
  },
);

/** Revoke the feed. Existing subscribers start getting 404s on refresh. */
planRoutes.delete(
  "/:planId/calendar-token",
  requireAuth,
  requireScope("practice:write"),
  plansWriteLimit,
  zValidator("param", planIdParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { planId } = c.req.valid("param");
    if (!(await planForWrite(planId, userId))) return c.json({ error: "Not found" }, 404);
    await updatePlan(planId, { icsToken: null });
    return c.body(null, 204);
  },
);

/**
 * The subscribable feed. Deliberately unauthenticated: the subscriber is a
 * calendar server with no session and no way to carry a JWT, so the token in
 * the query string is the whole credential. It is looked up first and the
 * path's planId only has to agree with it, which means a wrong token cannot
 * confirm that a plan id exists.
 */
planRoutes.get(
  "/:planId/calendar.ics",
  zValidator("param", planIdParam),
  zValidator("query", z.object({ token: z.string().uuid() })),
  async (c) => {
    const { planId } = c.req.valid("param");
    const plan = await getPlanByIcsToken(c.req.valid("query").token);
    if (!plan || plan.id !== planId) return c.json({ error: "Not found" }, 404);

    const tree = await getPlanTree(plan);
    // No cast: the plan tree already satisfies IcsPlan structurally, and
    // keeping it that way means a schema change breaks the build here.
    const body = buildPlanIcs(tree, {
      today: new Date().toISOString().slice(0, 10),
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${plan.slug}.ics"`,
        // The feed changes whenever the plan does; a subscriber refreshing on
        // its own cadence should not also be served a stale CDN copy.
        "Cache-Control": "no-store",
      },
    });
  },
);
