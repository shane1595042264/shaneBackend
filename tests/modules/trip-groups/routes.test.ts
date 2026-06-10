import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock the repo so we exercise the route logic (auth, validation, membership
// gating, status codes) without touching drizzle. Each route call may invoke
// multiple repo functions in sequence; mocking at the repo layer keeps the
// test surface tight.
const {
  mockCreateTripGroup,
  mockListGroupsForUser,
  mockGetGroupDetail,
  mockGetGroupBySlug,
  mockIsMember,
  mockAddMember,
  mockCreateIdea,
  mockGetIdeaById,
  mockDeleteIdeaById,
  mockSaveItinerary,
  mockConsolidateItinerary,
} = vi.hoisted(() => ({
  mockCreateTripGroup: vi.fn(),
  mockListGroupsForUser: vi.fn(),
  mockGetGroupDetail: vi.fn(),
  mockGetGroupBySlug: vi.fn(),
  mockIsMember: vi.fn(),
  mockAddMember: vi.fn(),
  mockCreateIdea: vi.fn(),
  mockGetIdeaById: vi.fn(),
  mockDeleteIdeaById: vi.fn(),
  mockSaveItinerary: vi.fn(),
  mockConsolidateItinerary: vi.fn(),
}));

vi.mock("@/modules/trip-groups/repo", () => ({
  createTripGroup: mockCreateTripGroup,
  listGroupsForUser: mockListGroupsForUser,
  getGroupDetail: mockGetGroupDetail,
  getGroupBySlug: mockGetGroupBySlug,
  isMember: mockIsMember,
  addMember: mockAddMember,
  createIdea: mockCreateIdea,
  getIdeaById: mockGetIdeaById,
  deleteIdeaById: mockDeleteIdeaById,
  saveItinerary: mockSaveItinerary,
}));

// Mock only the LLM call; keep the real itinerarySchema export so the
// route's re-validation of stored blobs behaves exactly as in prod.
vi.mock("@/modules/trip-groups/consolidator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/trip-groups/consolidator")>();
  return { ...actual, consolidateItinerary: mockConsolidateItinerary };
});

vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    await next();
  },
}));

import { tripGroupsRoutes } from "@/modules/trip-groups/routes";

beforeEach(() => {
  vi.clearAllMocks();
});

const app = new Hono().route("/api/trip-groups", tripGroupsRoutes);

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const IDEA_ID = "22222222-2222-2222-2222-222222222222";
const SLUG = "tokyo-2026";

const groupRow = {
  id: GROUP_ID,
  slug: SLUG,
  title: "Tokyo 2026",
  ownerId: USER_A,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-01T00:00:00Z"),
};

describe("POST /api/trip-groups", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tokyo" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty title", async () => {
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a group and returns 201", async () => {
    mockCreateTripGroup.mockResolvedValue(groupRow);
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ title: "Tokyo 2026" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.group.slug).toBe(SLUG);
    expect(body.group.title).toBe("Tokyo 2026");
    expect(mockCreateTripGroup).toHaveBeenCalledWith({ ownerId: USER_A, title: "Tokyo 2026" });
  });
});

describe("GET /api/trip-groups", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/trip-groups");
    expect(res.status).toBe(401);
  });

  it("flags isOwner per group", async () => {
    mockListGroupsForUser.mockResolvedValue([
      { ...groupRow, memberCount: 2, ideaCount: 5 },
      { ...groupRow, id: "33333333-3333-3333-3333-333333333333", slug: "kyoto", ownerId: USER_B, memberCount: 1, ideaCount: 0 },
    ]);
    const res = await app.request("/api/trip-groups", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0].isOwner).toBe(true);
    expect(body.groups[1].isOwner).toBe(false);
    expect(body.groups[0].memberCount).toBe(2);
    expect(body.groups[0].ideaCount).toBe(5);
  });
});

describe("GET /api/trip-groups/:slug", () => {
  it("returns 404 when group missing", async () => {
    mockGetGroupDetail.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not a member", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...groupRow,
      members: [{ userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date() }],
      ideas: [],
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("returns detail for a member", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...groupRow,
      members: [
        { userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date("2026-06-01T00:00:00Z") },
        { userId: USER_B, name: "Friend", role: "member", joinedAt: new Date("2026-06-02T00:00:00Z") },
      ],
      ideas: [
        { id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A, authorName: "Shane", body: "Visit Shibuya", createdAt: new Date("2026-06-03T00:00:00Z") },
      ],
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.members).toHaveLength(2);
    expect(body.group.ideas).toHaveLength(1);
    expect(body.group.ideas[0].body).toBe("Visit Shibuya");
    expect(body.group.isOwner).toBe(false);
  });
});

describe("POST /api/trip-groups/:slug/join", () => {
  it("reports joined=true on first join", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockAddMember.mockResolvedValue(true);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.joined).toBe(true);
    expect(body.alreadyMember).toBe(false);
  });

  it("reports alreadyMember=true on duplicate join", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockAddMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.joined).toBe(false);
    expect(body.alreadyMember).toBe(true);
  });

  it("returns 404 for missing slug", async () => {
    mockGetGroupBySlug.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/trip-groups/:slug/ideas", () => {
  it("rejects non-members with 403", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_B },
      body: JSON.stringify({ body: "Visit Shibuya" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects empty body", async () => {
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an idea and returns 201", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    mockCreateIdea.mockResolvedValue({
      id: IDEA_ID,
      groupId: GROUP_ID,
      authorId: USER_A,
      authorName: "Shane",
      body: "Visit Shibuya",
      createdAt: new Date("2026-06-03T00:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ body: "  Visit Shibuya  " }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.body).toBe("Visit Shibuya");
    expect(mockCreateIdea).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      authorId: USER_A,
      body: "Visit Shibuya",
    });
  });
});

describe("DELETE /api/trip-groups/:slug/ideas/:ideaId", () => {
  it("returns 403 when caller is not the idea author", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({ id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when idea belongs to a different group", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({
      id: IDEA_ID,
      groupId: "99999999-9999-9999-9999-999999999999",
      authorId: USER_A,
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("deletes when caller is the author", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({ id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A });
    mockDeleteIdeaById.mockResolvedValue(true);
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/trip-groups/:slug/itinerary/consolidate", () => {
  const ITINERARY = {
    summary: "Three days across central Tokyo.",
    days: [
      {
        day: 1,
        title: "Shibuya + Shinjuku",
        location: "Tokyo",
        activities: [{ time: "09:00", title: "Meiji Shrine", notes: null }],
      },
    ],
  };

  const detailWithIdeas = {
    ...groupRow,
    itinerary: null,
    itineraryGeneratedAt: null,
    members: [
      { userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date("2026-06-01T00:00:00Z") },
      { userId: USER_B, name: "Ben", role: "member", joinedAt: new Date("2026-06-02T00:00:00Z") },
    ],
    ideas: [
      {
        id: IDEA_ID,
        groupId: GROUP_ID,
        authorId: USER_B,
        authorName: "Ben",
        body: "Meiji Shrine early morning",
        createdAt: new Date("2026-06-03T00:00:00Z"),
      },
    ],
  };

  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when group missing", async () => {
    mockGetGroupDetail.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner members", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
    expect(mockConsolidateItinerary).not.toHaveBeenCalled();
  });

  it("returns 400 when the idea inbox is empty", async () => {
    mockGetGroupDetail.mockResolvedValue({ ...detailWithIdeas, ideas: [] });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(400);
    expect(mockConsolidateItinerary).not.toHaveBeenCalled();
  });

  it("consolidates, persists, and returns the itinerary for the owner", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockResolvedValue({
      itinerary: ITINERARY,
      modelUsed: "claude-sonnet-4-20250514",
    });
    mockSaveItinerary.mockResolvedValue({
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itinerary.summary).toBe(ITINERARY.summary);
    expect(body.itineraryGeneratedAt).toBe("2026-06-10T12:00:00.000Z");
    expect(mockSaveItinerary).toHaveBeenCalledWith(GROUP_ID, ITINERARY);
    // No stored itinerary → LLM gets no base to refine.
    expect(mockConsolidateItinerary).toHaveBeenCalledWith(
      expect.objectContaining({ existingItinerary: null }),
    );
  });

  it("passes a previously stored itinerary to the LLM as the base", async () => {
    mockGetGroupDetail.mockResolvedValue({ ...detailWithIdeas, itinerary: ITINERARY });
    mockConsolidateItinerary.mockResolvedValue({
      itinerary: ITINERARY,
      modelUsed: "claude-sonnet-4-20250514",
    });
    mockSaveItinerary.mockResolvedValue({
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    expect(mockConsolidateItinerary).toHaveBeenCalledWith(
      expect.objectContaining({ existingItinerary: ITINERARY }),
    );
  });

  it("maps LLM-chain exhaustion to 502 and does not persist", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockRejectedValue(
      new Error("All LLM providers failed. Anthropic: boom; Groq: bust"),
    );
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(502);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
  });

  it("maps invalid AI output to 502", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockRejectedValue(
      new Error("AI itinerary failed schema validation (model: x): days: Required"),
    );
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(502);
  });

  it("GET detail carries itinerary + itineraryGeneratedAt", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...detailWithIdeas,
      itinerary: ITINERARY,
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.itinerary.days).toHaveLength(1);
    expect(body.group.itineraryGeneratedAt).toBe("2026-06-10T12:00:00.000Z");
  });
});
