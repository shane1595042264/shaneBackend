// tests/modules/journal/images-routes.test.ts
//
// Route-level tests for POST/GET /api/journal/images. Verifies the SHAN-219
// hardening: client-supplied Content-Type is ignored in favor of magic-byte
// sniffing (SVG and HTML-as-PNG both rejected), and the GET response carries
// X-Content-Type-Options: nosniff + Content-Disposition: inline. Also pins
// the SHAN-220 per-user daily upload quota: 100 uploads / trailing 24h,
// 429 + Retry-After when exceeded, count resets as old rows fall out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockInsertImage, mockGetImageById, mockCountUploadsInWindow, mockSelect } = vi.hoisted(() => ({
  mockInsertImage: vi.fn(),
  mockGetImageById: vi.fn(),
  mockCountUploadsInWindow: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  DEFAULT_TIMEZONE: "America/Chicago",
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  getEntryByDate: vi.fn(),
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  hashContent: (s: string) => s,
}));
vi.mock("@/modules/journal/appends-repo", () => ({
  createAppend: vi.fn(),
  listAppendsForEntry: vi.fn(),
}));
vi.mock("@/modules/journal/versions-repo", () => ({
  appendDirectVersion: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  revertToVersion: vi.fn(),
  VersionConflictError: class extends Error {},
}));
vi.mock("@/modules/journal/suggestions-repo", () => ({
  createSuggestion: vi.fn(),
  listSuggestionsForEntry: vi.fn(),
  getSuggestion: vi.fn(),
  inboxFor: vi.fn(),
  approveSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  withdrawSuggestion: vi.fn(),
}));
vi.mock("@/modules/journal/comments-repo", () => ({
  createComment: vi.fn(),
  listForEntry: vi.fn(),
  getComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));
vi.mock("@/modules/journal/reactions-repo", () => ({
  toggleEntryReaction: vi.fn(),
  toggleCommentReaction: vi.fn(),
  isAllowedEmoji: () => true,
  summarizeEntryReactions: vi.fn(),
  listMyReactionsForEntry: vi.fn(),
  summarizeCommentReactions: vi.fn(),
  listMyReactionsForComment: vi.fn(),
}));
vi.mock("@/modules/journal/images-repo", () => ({
  insertImage: mockInsertImage,
  getImageById: mockGetImageById,
  countUploadsInWindow: mockCountUploadsInWindow,
}));
vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  journalEntries: {},
  journalVersions: {},
  journalSuggestions: {},
  journalComments: {},
  journalImages: {},
  entryReactions: {},
  commentReactions: {},
}));
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the caller is well under quota. Quota-specific tests override.
  mockCountUploadsInWindow.mockResolvedValue({ count: 0, oldestCreatedAt: null });
});
const app = new Hono().route("/api/journal", journalRoutes);

// Smallest legal PNG: 8-byte signature + IHDR/IDAT/IEND stubs are not
// required for the sniffer, which only inspects the first 8 bytes.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe("POST /api/journal/images", () => {
  it("401 without auth", async () => {
    const form = new FormData();
    form.append("file", new File([PNG_SIG], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", { method: "POST", body: form });
    expect(res.status).toBe(401);
    expect(mockInsertImage).not.toHaveBeenCalled();
  });

  it("accepts a real PNG and stores the sniffed mime, not the client-supplied one", async () => {
    mockInsertImage.mockResolvedValue({ id: "img-1" });
    const form = new FormData();
    // Client lies about the type — server should still derive image/png from bytes.
    form.append("file", new File([PNG_SIG], "x.png", { type: "application/octet-stream" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "img-1", url: "/api/journal/images/img-1" });
    expect(mockInsertImage).toHaveBeenCalledTimes(1);
    expect(mockInsertImage.mock.calls[0][0].mimeType).toBe("image/png");
    expect(mockInsertImage.mock.calls[0][0].uploadedBy).toBe("u1");
  });

  it("415 when client uploads an SVG even with image/svg+xml content type", async () => {
    const svgBytes = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const form = new FormData();
    form.append("file", new File([svgBytes], "x.svg", { type: "image/svg+xml" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/png\/jpeg\/gif\/webp/);
    expect(mockInsertImage).not.toHaveBeenCalled();
  });

  it("415 when HTML bytes are masquerading as image/png", async () => {
    const html = "<!doctype html><html><body><script>alert(1)</script></body></html>";
    const form = new FormData();
    form.append("file", new File([html], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(415);
    expect(mockInsertImage).not.toHaveBeenCalled();
  });

  it("400 when no file field", async () => {
    const form = new FormData();
    form.append("notfile", "oops");
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("413 when payload exceeds 5MB cap", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
    const form = new FormData();
    form.append("file", new File([big], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(413);
    expect(mockInsertImage).not.toHaveBeenCalled();
  });

  it("accepts when user is under the 100/24h quota", async () => {
    mockCountUploadsInWindow.mockResolvedValue({
      count: 99,
      oldestCreatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    mockInsertImage.mockResolvedValue({ id: "img-ok" });
    const form = new FormData();
    form.append("file", new File([PNG_SIG], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(mockInsertImage).toHaveBeenCalledTimes(1);
    // Confirm we passed a Date in the trailing 24h to the repo helper.
    const since = mockCountUploadsInWindow.mock.calls[0][1] as Date;
    const ageMs = Date.now() - since.getTime();
    expect(ageMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("429 with Retry-After when at the 100/24h quota", async () => {
    // Oldest of 100 uploaded 23h ago → window-exit is in ~1h, so Retry-After
    // should be close to 3600s.
    const oldestCreatedAt = new Date(Date.now() - 23 * 60 * 60 * 1000);
    mockCountUploadsInWindow.mockResolvedValue({ count: 100, oldestCreatedAt });
    const form = new FormData();
    form.append("file", new File([PNG_SIG], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(429);
    expect(mockInsertImage).not.toHaveBeenCalled();
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect((await res.json()).error).toMatch(/quota/i);
  });

  it("accepts again when old uploads have rolled out of the 24h window", async () => {
    // Simulates the calm-after-the-storm: yesterday's burst is gone, the
    // trailing window holds zero rows even though the user has uploaded
    // historically. Quota logic must not look further back than `since`.
    mockCountUploadsInWindow.mockResolvedValue({ count: 0, oldestCreatedAt: null });
    mockInsertImage.mockResolvedValue({ id: "img-rolled" });
    const form = new FormData();
    form.append("file", new File([PNG_SIG], "x.png", { type: "image/png" }));
    const res = await app.request("/api/journal/images", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(mockInsertImage).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/journal/images/:id", () => {
  it("streams bytes with nosniff + inline disposition + immutable cache", async () => {
    mockGetImageById.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      mimeType: "image/png",
      byteSize: PNG_SIG.byteLength,
      data: PNG_SIG,
    });
    const res = await app.request("/api/journal/images/11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("404 when not found", async () => {
    mockGetImageById.mockResolvedValue(null);
    const res = await app.request("/api/journal/images/11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(404);
  });

  it("400 when id is not a uuid", async () => {
    const res = await app.request("/api/journal/images/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
