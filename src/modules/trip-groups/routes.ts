import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@/modules/auth/middleware";
import {
  createTripGroup,
  listGroupsForUser,
  getGroupDetail,
  getGroupBySlug,
  isMember,
  addMember,
  createIdea,
  getIdeaById,
  deleteIdeaById,
  saveItinerary,
  createSuggestion,
  listSuggestions,
  getSuggestionById,
  resolveSuggestion,
  type ItinerarySuggestion,
} from "./repo";
import {
  consolidateItinerary,
  itinerarySchema,
  computeChangedDays,
} from "./consolidator";

type AuthEnv = { Variables: { userId: string } };

/**
 * Trip-Groups routes — Phase 1 of SHAN-266.
 *
 * All endpoints require a browser JWT (PATs deferred). The user must be
 * a member of the group to read its detail or post an idea. Anyone with
 * the slug can join via POST /:slug/join — invite-by-email lands in
 * Phase 2.
 */
export const tripGroupsRoutes = new Hono<AuthEnv>();
tripGroupsRoutes.use("*", requireAuth);

const slugParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
});

const ideaIdParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  ideaId: z.string().uuid(),
});

const createGroupBody = z.object({
  title: z.string().min(1).max(200),
});

const createIdeaBody = z.object({
  body: z.string().min(1).max(4000),
});

tripGroupsRoutes.post("/", zValidator("json", createGroupBody), async (c) => {
  const userId = c.get("userId");
  const { title } = c.req.valid("json");
  const group = await createTripGroup({ ownerId: userId, title: title.trim() });
  return c.json(
    {
      group: {
        id: group.id,
        slug: group.slug,
        title: group.title,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
      },
    },
    201,
  );
});

tripGroupsRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const groups = await listGroupsForUser(userId);
  return c.json({
    groups: groups.map((g) => ({
      id: g.id,
      slug: g.slug,
      title: g.title,
      ownerId: g.ownerId,
      isOwner: g.ownerId === userId,
      memberCount: g.memberCount,
      ideaCount: g.ideaCount,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  });
});

tripGroupsRoutes.get("/:slug", zValidator("param", slugParam), async (c) => {
  const userId = c.get("userId");
  const { slug } = c.req.valid("param");
  const detail = await getGroupDetail(slug);
  if (!detail) return c.json({ error: "Not found" }, 404);
  const userIsMember = detail.members.some((m) => m.userId === userId);
  if (!userIsMember) return c.json({ error: "Not a member of this group" }, 403);

  return c.json({
    group: {
      id: detail.id,
      slug: detail.slug,
      title: detail.title,
      ownerId: detail.ownerId,
      isOwner: detail.ownerId === userId,
      createdAt: detail.createdAt.toISOString(),
      updatedAt: detail.updatedAt.toISOString(),
      itinerary: detail.itinerary ?? null,
      itineraryGeneratedAt: detail.itineraryGeneratedAt?.toISOString() ?? null,
      members: detail.members.map((m) => ({
        userId: m.userId,
        name: m.name,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
      ideas: detail.ideas.map((i) => ({
        id: i.id,
        authorId: i.authorId,
        authorName: i.authorName,
        body: i.body,
        createdAt: i.createdAt.toISOString(),
      })),
    },
  });
});

tripGroupsRoutes.post("/:slug/join", zValidator("param", slugParam), async (c) => {
  const userId = c.get("userId");
  const { slug } = c.req.valid("param");
  const group = await getGroupBySlug(slug);
  if (!group) return c.json({ error: "Not found" }, 404);
  const added = await addMember(group.id, userId);
  return c.json({
    joined: added,
    alreadyMember: !added,
    group: {
      id: group.id,
      slug: group.slug,
      title: group.title,
    },
  });
});

tripGroupsRoutes.post(
  "/:slug/ideas",
  zValidator("param", slugParam),
  zValidator("json", createIdeaBody),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (!(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    const idea = await createIdea({ groupId: group.id, authorId: userId, body: body.trim() });
    return c.json(
      {
        idea: {
          id: idea.id,
          authorId: idea.authorId,
          authorName: idea.authorName,
          body: idea.body,
          createdAt: idea.createdAt.toISOString(),
        },
      },
      201,
    );
  },
);

function suggestionJson(s: ItinerarySuggestion) {
  return {
    id: s.id,
    authorId: s.authorId,
    authorName: s.authorName,
    itinerary: s.itinerary,
    changedDays: s.changedDays,
    note: s.note,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    resolvedAt: s.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Consolidate the group's idea inbox into a structured itinerary via the
 * LLM (SHAN-272 Phase 3, member path SHAN-273 Phase 4). The owner's
 * result is written directly to the group; a non-owner member's result
 * lands as a pending suggestion awaiting owner approval.
 */
tripGroupsRoutes.post(
  "/:slug/itinerary/consolidate",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const detail = await getGroupDetail(slug);
    if (!detail) return c.json({ error: "Not found" }, 404);
    const isOwner = detail.ownerId === userId;
    if (!isOwner && !detail.members.some((m) => m.userId === userId)) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    if (detail.ideas.length === 0) {
      return c.json({ error: "Post at least one idea before consolidating" }, 400);
    }

    // A previously stored itinerary is passed back to the LLM as the base
    // so re-consolidation refines instead of starting over. Stored JSON is
    // re-validated here — if a future phase changes the shape, the old blob
    // silently degrades to "no base" instead of corrupting the prompt.
    const existing = itinerarySchema.safeParse(detail.itinerary);
    const base = existing.success ? existing.data : null;

    try {
      const { itinerary, modelUsed } = await consolidateItinerary({
        groupTitle: detail.title,
        ideas: detail.ideas.map((i) => ({ authorName: i.authorName, body: i.body })),
        existingItinerary: base,
      });

      if (isOwner) {
        const { itineraryGeneratedAt } = await saveItinerary(detail.id, itinerary);
        return c.json({
          itinerary,
          itineraryGeneratedAt: itineraryGeneratedAt.toISOString(),
          modelUsed,
        });
      }

      const suggestion = await createSuggestion({
        groupId: detail.id,
        authorId: userId,
        itinerary,
        changedDays: computeChangedDays(base, itinerary),
        note: null,
      });
      return c.json({ suggestion: suggestionJson(suggestion), modelUsed }, 201);
    } catch (err) {
      const message = (err as Error).message;
      // Same contract as knowledge/routes.ts: 502 = upstream LLM trouble
      // (chain exhausted or bad output), retryable; 500 = our bug.
      const status =
        message.includes("All LLM providers failed") || message.startsWith("AI ")
          ? 502
          : 500;
      return c.json({ error: message }, status);
    }
  },
);

/**
 * List itinerary suggestions for the group (SHAN-273). Member-gated.
 * Each pending suggestion carries conflictsWith: ids of OTHER pending
 * suggestions whose changedDays intersect — both are competing to edit
 * the same day(s), so approving one likely invalidates the other.
 */
tripGroupsRoutes.get(
  "/:slug/itinerary/suggestions",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (!(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    const suggestions = await listSuggestions(group.id);
    const pending = suggestions.filter((s) => s.status === "pending");
    const conflicts = new Map<string, string[]>();
    for (const a of pending) {
      conflicts.set(
        a.id,
        pending
          .filter((b) => b.id !== a.id && b.changedDays.some((d) => a.changedDays.includes(d)))
          .map((b) => b.id),
      );
    }
    return c.json({
      suggestions: suggestions.map((s) => ({
        ...suggestionJson(s),
        conflictsWith: conflicts.get(s.id) ?? [],
      })),
    });
  },
);

const suggestionIdParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  suggestionId: z.string().uuid(),
});

/** Owner approves: the proposed itinerary becomes the group itinerary. */
tripGroupsRoutes.post(
  "/:slug/itinerary/suggestions/:suggestionId/approve",
  zValidator("param", suggestionIdParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug, suggestionId } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (group.ownerId !== userId) {
      return c.json({ error: "Only the group owner can approve suggestions" }, 403);
    }
    const suggestion = await getSuggestionById(suggestionId);
    if (!suggestion || suggestion.groupId !== group.id) {
      return c.json({ error: "Not found" }, 404);
    }
    const proposed = itinerarySchema.safeParse(suggestion.itinerary);
    if (!proposed.success) {
      return c.json({ error: "Stored suggestion no longer matches the itinerary schema" }, 422);
    }
    // Claim pending status BEFORE applying — the status-guarded UPDATE makes
    // concurrent approve/reject race-safe (loser gets null → 409).
    const resolved = await resolveSuggestion(suggestionId, "approved", userId);
    if (!resolved) return c.json({ error: "Suggestion already resolved" }, 409);
    const { itineraryGeneratedAt } = await saveItinerary(group.id, proposed.data);
    return c.json({
      suggestion: { id: suggestionId, status: "approved" },
      itinerary: proposed.data,
      itineraryGeneratedAt: itineraryGeneratedAt.toISOString(),
    });
  },
);

/** Owner rejects: suggestion is resolved without touching the itinerary. */
tripGroupsRoutes.post(
  "/:slug/itinerary/suggestions/:suggestionId/reject",
  zValidator("param", suggestionIdParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug, suggestionId } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (group.ownerId !== userId) {
      return c.json({ error: "Only the group owner can reject suggestions" }, 403);
    }
    const suggestion = await getSuggestionById(suggestionId);
    if (!suggestion || suggestion.groupId !== group.id) {
      return c.json({ error: "Not found" }, 404);
    }
    const resolved = await resolveSuggestion(suggestionId, "rejected", userId);
    if (!resolved) return c.json({ error: "Suggestion already resolved" }, 409);
    return c.json({ suggestion: { id: suggestionId, status: "rejected" } });
  },
);

tripGroupsRoutes.delete(
  "/:slug/ideas/:ideaId",
  zValidator("param", ideaIdParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug, ideaId } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    const idea = await getIdeaById(ideaId);
    if (!idea || idea.groupId !== group.id) return c.json({ error: "Not found" }, 404);
    if (idea.authorId !== userId) return c.json({ error: "Only the author can delete" }, 403);
    const ok = await deleteIdeaById(ideaId, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);
