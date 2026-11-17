// src/modules/blog/reading-routes.ts
//
// SHAN-705: reading positions on blog posts, mounted at /api/blog/reading.
// The journal's twin (journal/reading-routes.ts), minus the membership gate:
// published posts are public, so any signed-in reader can be partway through
// one. Its own router for the same reason as the journal's: it is browser-
// session only, and the blog route tests mock the auth middleware without
// requireBrowserSession.
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireBrowserSession, type AuthVars } from "@/modules/auth/middleware";
import { zValidator } from "@/modules/shared/zod-validator";
import { readingListQuery, readingSaveBody } from "@/modules/shared/reading-position";
import {
  getBlogReadingPosition,
  listBlogReadingPositions,
  postForSlug,
  saveBlogReadingPosition,
} from "./reading-repo";

export const blogReadingRoutes = new Hono<{ Variables: AuthVars }>();

// A position belongs to a person reading in a browser; an agent has nothing to save.
blogReadingRoutes.use("*", requireAuth, requireBrowserSession("Reading positions"));

// The same rule blog/routes.ts applies to a slug.
const slugParam = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Invalid slug" }),
});

blogReadingRoutes.get("/", zValidator("query", readingListQuery), async (c) => {
  const { limit } = c.req.valid("query");
  const positions = await listBlogReadingPositions(c.get("userId")!, limit);
  return c.json({ positions });
});

blogReadingRoutes.get("/:slug", zValidator("param", slugParam), async (c) => {
  const { slug } = c.req.valid("param");
  const position = await getBlogReadingPosition(c.get("userId")!, slug);
  return c.json({ position });
});

blogReadingRoutes.put(
  "/:slug",
  zValidator("param", slugParam),
  zValidator("json", readingSaveBody),
  async (c) => {
    const { slug } = c.req.valid("param");
    const body = c.req.valid("json");
    const post = await postForSlug(slug);
    if (!post) return c.json({ error: "Not found" }, 404);
    const position = await saveBlogReadingPosition({
      userId: c.get("userId")!,
      post,
      slug,
      progress: body.progress,
      anchor: body.anchor,
    });
    return c.json({ position });
  }
);
