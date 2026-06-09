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
} from "./repo";

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
