import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { repo } = vi.hoisted(() => ({
  repo: {
    postForSlug: vi.fn(),
    getBlogReadingPosition: vi.fn(),
    listBlogReadingPositions: vi.fn(),
    saveBlogReadingPosition: vi.fn(),
  },
}));

vi.mock("@/modules/blog/reading-repo", () => repo);
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Token") ? ["entries:write"] : null);
    await next();
  },
  requireBrowserSession: (feature: string) => async (c: any, next: any) => {
    if (c.get("tokenScopes") !== null) return c.json({ error: `${feature} requires a browser session, not a PAT` }, 403);
    await next();
  },
}));

import { blogReadingRoutes } from "@/modules/blog/reading-routes";

const app = new Hono().route("/api/blog/reading", blogReadingRoutes);
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "X-Test-User": "u1" }) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const POST = { id: "33333333-3333-4333-8333-333333333333", title: "How I use AI in the apps I build" };
const SLUG = "how-i-use-ai-in-the-apps-i-build";
const anchor = { block: 3, offset: 0.25, text: "Most of the AI here is a classifier." };
const saved = { slug: SLUG, title: POST.title, progress: 0.4, anchor, updatedAt: "2026-11-17T18:00:00.000Z" };

beforeEach(() => vi.clearAllMocks());

describe("/api/blog/reading guards", () => {
  it("401s signed-out callers and 403s every PAT, before touching the database", async () => {
    expect((await send("GET", "/api/blog/reading", undefined, {})).status).toBe(401);
    const pat = await send("PUT", `/api/blog/reading/${SLUG}`, { progress: 0.5, anchor }, {
      "X-Test-User": "u1",
      "X-Test-Token": "t",
    });
    expect(pat.status).toBe(403);
    expect(repo.postForSlug).not.toHaveBeenCalled();
    expect(repo.saveBlogReadingPosition).not.toHaveBeenCalled();
  });
});

describe("PUT /api/blog/reading/:slug", () => {
  it("saves the caller's position on a published post and returns it with the title", async () => {
    repo.postForSlug.mockResolvedValue(POST);
    repo.saveBlogReadingPosition.mockResolvedValue(saved);
    const res = await send("PUT", `/api/blog/reading/${SLUG}`, { progress: 0.4, anchor });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ position: saved });
    expect(repo.saveBlogReadingPosition).toHaveBeenCalledWith({ userId: "u1", post: POST, slug: SLUG, progress: 0.4, anchor });
  });

  it("404s a slug with no published post (drafts, trashed, unknown)", async () => {
    repo.postForSlug.mockResolvedValue(null);
    const res = await send("PUT", `/api/blog/reading/${SLUG}`, { progress: 0.5, anchor });
    expect(res.status).toBe(404);
    expect(repo.saveBlogReadingPosition).not.toHaveBeenCalled();
  });

  it("drops a lone surrogate the client's slice left in the anchor text", async () => {
    repo.postForSlug.mockResolvedValue(POST);
    repo.saveBlogReadingPosition.mockResolvedValue(saved);
    await send("PUT", `/api/blog/reading/${SLUG}`, { progress: 0.5, anchor: { ...anchor, text: "Recap \ud83c" } });
    expect(repo.saveBlogReadingPosition.mock.calls[0][0].anchor.text).toBe("Recap ");
  });

  it.each([
    ["progress above 1", { progress: 1.2, anchor }],
    ["no anchor", { progress: 0.5 }],
    ["an unknown key", { progress: 0.5, anchor, scrollY: 900 }],
    ["text over 200 chars", { progress: 0.5, anchor: { ...anchor, text: "x".repeat(201) } }],
  ])("400s %s", async (_label, body) => {
    repo.postForSlug.mockResolvedValue(POST);
    const res = await send("PUT", `/api/blog/reading/${SLUG}`, body);
    expect(res.status).toBe(400);
    expect(repo.saveBlogReadingPosition).not.toHaveBeenCalled();
  });

  it("400s a malformed slug before touching the database", async () => {
    const res = await send("PUT", "/api/blog/reading/Not_A_Slug", { progress: 0.5, anchor });
    expect(res.status).toBe(400);
    expect(repo.postForSlug).not.toHaveBeenCalled();
  });
});

describe("GET /api/blog/reading", () => {
  it("lists the caller's positions, 20 by default, capped at 100", async () => {
    repo.listBlogReadingPositions.mockResolvedValue([saved]);
    const res = await send("GET", "/api/blog/reading");
    expect(await res.json()).toEqual({ positions: [saved] });
    expect(repo.listBlogReadingPositions).toHaveBeenCalledWith("u1", 20);
    expect((await send("GET", "/api/blog/reading?limit=101")).status).toBe(400);
  });

  it("returns one post's position, or null", async () => {
    repo.getBlogReadingPosition.mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    expect(await (await send("GET", `/api/blog/reading/${SLUG}`)).json()).toEqual({ position: saved });
    expect(await (await send("GET", "/api/blog/reading/other-post")).json()).toEqual({ position: null });
    expect(repo.getBlogReadingPosition).toHaveBeenLastCalledWith("u1", "other-post");
  });
});
