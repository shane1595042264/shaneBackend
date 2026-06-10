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
import {
  insertUserPhoto,
  insertUnsplashPhoto,
  listPhotos,
  getPhotoMeta,
  getPhotoBytes,
  deletePhotoById,
  type TripGroupPhotoMeta,
} from "./photos-repo";
import { searchUnsplashPhoto } from "./unsplash";
import {
  buildEventsFromItinerary,
  deletePreviousExport,
  insertEvents,
} from "./calendar-export";
import { getAccessTokenForUser } from "@/modules/integrations/calendar-connect";
import { users } from "@/db/schema";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { sniffImageMime } from "@/modules/shared/image-validate";

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

const photoIdOnlyParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  photoId: z.string().uuid(),
});

// Raw photo bytes — registered BEFORE the auth middleware on purpose:
// <img> tags can't carry Authorization headers, so this is public and
// uuid-addressed, exactly like GET /api/journal/images/:id (SHAN-275).
tripGroupsRoutes.get(
  "/:slug/itinerary/photos/:photoId/raw",
  zValidator("param", photoIdOnlyParam),
  async (c) => {
    const { photoId } = c.req.valid("param");
    const row = await getPhotoBytes(photoId);
    if (!row?.data || !row.mimeType) return c.json({ error: "Not found" }, 404);
    return new Response(new Uint8Array(row.data), {
      status: 200,
      headers: {
        "Content-Type": row.mimeType,
        "Content-Length": String(row.byteSize ?? row.data.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  },
);

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
 * Export the itinerary into the caller's connected Google Calendar
 * (SHAN-278). Member-gated. 409 calendar_not_connected drives the
 * frontend's connect-first popup. Re-export wipes the previous batch
 * (events tagged shaneTripGroup=<groupId>) before inserting.
 */
tripGroupsRoutes.post(
  "/:slug/itinerary/export-calendar",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (group.ownerId !== userId && !(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    const itin = itinerarySchema.safeParse(group.itinerary);
    if (!itin.success) {
      return c.json({ error: "No itinerary yet — consolidate first" }, 400);
    }

    const accessToken = await getAccessTokenForUser(userId).catch((err) => {
      throw err;
    });
    if (!accessToken) {
      return c.json({ error: "calendar_not_connected" }, 409);
    }

    const [u] = await db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId));
    const timeZone = u?.timezone ?? "America/Chicago";

    const { events, skippedDays } = buildEventsFromItinerary(
      group.title,
      group.id,
      itin.data,
      timeZone,
    );
    if (events.length === 0) {
      return c.json(
        { error: "No days carry dates yet — add dates to the itinerary first" },
        400,
      );
    }

    try {
      const deleted = await deletePreviousExport(accessToken, group.id);
      const created = await insertEvents(accessToken, events);
      return c.json({ created, deletedPrevious: deleted, skippedDays });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  },
);

const putItineraryBody = z.object({
  itinerary: itinerarySchema,
});

/**
 * Manual itinerary edit (SHAN-276, Phase 6). Same write semantics as
 * consolidate: the owner writes directly; a non-owner member's edit lands
 * as a pending suggestion with server-computed changedDays.
 */
tripGroupsRoutes.put(
  "/:slug/itinerary",
  zValidator("param", slugParam),
  zValidator("json", putItineraryBody),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const { itinerary } = c.req.valid("json");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    const isOwner = group.ownerId === userId;
    if (!isOwner && !(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    if (isOwner) {
      const { itineraryGeneratedAt } = await saveItinerary(group.id, itinerary);
      return c.json({ itinerary, itineraryGeneratedAt: itineraryGeneratedAt.toISOString() });
    }

    const base = itinerarySchema.safeParse(group.itinerary);
    const suggestion = await createSuggestion({
      groupId: group.id,
      authorId: userId,
      itinerary,
      changedDays: computeChangedDays(base.success ? base.data : null, itinerary),
      note: "Manual edit",
    });
    return c.json({ suggestion: suggestionJson(suggestion) }, 201);
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

// ---------------------------------------------------------------------------
// Itinerary photos (SHAN-275, Phase 5)
// ---------------------------------------------------------------------------

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

function photoJson(p: TripGroupPhotoMeta, slug: string) {
  return {
    id: p.id,
    day: p.day,
    source: p.source,
    uploaderId: p.uploaderId,
    // user rows serve from our raw route; unsplash rows hotlink.
    url:
      p.source === "user"
        ? `/api/trip-groups/${slug}/itinerary/photos/${p.id}/raw`
        : p.externalUrl,
    attribution: p.attribution,
    createdAt: p.createdAt.toISOString(),
  };
}

/** List photo metadata for the group (member-gated). */
tripGroupsRoutes.get(
  "/:slug/itinerary/photos",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (!(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    const photos = await listPhotos(group.id);
    return c.json({ photos: photos.map((p) => photoJson(p, slug)) });
  },
);

/** Upload a photo for a day (member-gated, multipart, magic-byte sniffed). */
tripGroupsRoutes.post(
  "/:slug/itinerary/photos",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (!(await isMember(group.id, userId))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Expected multipart/form-data with 'file' and 'day' fields" }, 400);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    const dayRaw = form.get("day");
    const day = Number(typeof dayRaw === "string" ? dayRaw : NaN);
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' in multipart upload" }, 400);
    }
    if (!Number.isInteger(day) || day < 1 || day > 365) {
      return c.json({ error: "'day' must be an integer between 1 and 365" }, 400);
    }
    if (file.size === 0) return c.json({ error: "Empty file" }, 400);
    if (file.size > PHOTO_MAX_BYTES) {
      return c.json({ error: "Image too large (max 5MB)" }, 413);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffedMime = sniffImageMime(buffer);
    if (!sniffedMime) {
      return c.json({ error: "Unsupported image type — png/jpeg/gif/webp only" }, 415);
    }
    const photo = await insertUserPhoto({
      groupId: group.id,
      day,
      uploaderId: userId,
      mimeType: sniffedMime,
      data: buffer,
    });
    return c.json({ photo: photoJson(photo, slug) }, 201);
  },
);

/** Delete a photo: its uploader or the group owner. Unsplash rows count
 * as owner-managed (uploaderId is null). */
tripGroupsRoutes.delete(
  "/:slug/itinerary/photos/:photoId",
  zValidator("param", photoIdOnlyParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug, photoId } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    const meta = await getPhotoMeta(photoId);
    if (!meta || meta.groupId !== group.id) return c.json({ error: "Not found" }, 404);
    const allowed = meta.uploaderId === userId || group.ownerId === userId;
    if (!allowed) {
      return c.json({ error: "Only the uploader or group owner can delete a photo" }, 403);
    }
    const ok = await deletePhotoById(photoId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);

/**
 * Owner-triggered Unsplash fallback: every itinerary day that has a
 * location and zero photos gets one hotlinked Unsplash hit. Partial
 * success is fine — days whose search fails are reported, not fatal.
 */
tripGroupsRoutes.post(
  "/:slug/itinerary/photos/unsplash-fill",
  zValidator("param", slugParam),
  async (c) => {
    const userId = c.get("userId");
    const { slug } = c.req.valid("param");
    const group = await getGroupBySlug(slug);
    if (!group) return c.json({ error: "Not found" }, 404);
    if (group.ownerId !== userId) {
      return c.json({ error: "Only the group owner can fill photos from Unsplash" }, 403);
    }
    const itin = itinerarySchema.safeParse(group.itinerary);
    if (!itin.success) {
      return c.json({ error: "No itinerary yet — consolidate first" }, 400);
    }
    // One photo per distinct location, not per day (SHAN-279): photos are
    // design backgrounds now — a location's photo covers every day that
    // shares it, so repeated fetches just duplicated the same image.
    const existing = await listPhotos(group.id);
    const dayLocation = new Map(itin.data.days.map((d) => [d.day, d.location]));
    const coveredLocations = new Set(
      existing.map((p) => dayLocation.get(p.day)).filter((l): l is string => !!l),
    );
    const seenLocations = new Set<string>();
    const targets = itin.data.days.filter((d) => {
      if (!d.location || coveredLocations.has(d.location) || seenLocations.has(d.location)) {
        return false;
      }
      seenLocations.add(d.location);
      return true;
    });
    if (targets.length === 0) {
      return c.json({ photos: [], skipped: [], message: "Every location already has a photo" });
    }

    const created: ReturnType<typeof photoJson>[] = [];
    const skipped: { day: number; reason: string }[] = [];
    for (const d of targets) {
      try {
        const hit = await searchUnsplashPhoto(d.location as string);
        if (!hit) {
          skipped.push({ day: d.day, reason: "no Unsplash results" });
          continue;
        }
        const photo = await insertUnsplashPhoto({
          groupId: group.id,
          day: d.day,
          externalUrl: hit.url,
          attribution: hit.attribution,
        });
        created.push(photoJson(photo, slug));
      } catch (err) {
        skipped.push({ day: d.day, reason: (err as Error).message });
      }
    }
    // All-fail with a key problem reads as upstream trouble → 502.
    if (created.length === 0 && skipped.length > 0) {
      return c.json({ error: `Unsplash fill failed: ${skipped[0].reason}`, skipped }, 502);
    }
    return c.json({ photos: created, skipped });
  },
);
